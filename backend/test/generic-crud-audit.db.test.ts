import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';

import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool, makeAppPool } from './helpers';
import { mountGenericRoutes } from '../src/app';
import { resolveCrudAccess } from '../src/routes/crud-policy';
import { crudEventType } from '../src/routes/crud-audit';
import type { WriteOperation } from '../src/routes/crud-audit';
import { getTableKeys } from '../../shared/src/utils/utils';
import type { TableKey } from '../../shared/src/ssot/derived';
import type { AuthUser } from '../src/auth';
import { makeApiClient, dataOf } from './api_client';
import type { JsonBody } from './api_client';

// The op list the SSOT exposes through the generic engine, derived — never a hand-kept copy.
// A table that starts exposing a generic write shows up here on its own, and the fixture guard
// below fails until someone proves that write is audited.
const WRITE_OPS: WriteOperation[] = ['create', 'update', 'delete'];

const EXPOSED_WRITES: Array<{ table: TableKey; op: WriteOperation }> = getTableKeys().flatMap(
  (table) =>
    WRITE_OPS.filter((op) => resolveCrudAccess(table, op).allowed).map((op) => ({ table, op })),
);

type Seeded = { id: number; update: JsonBody };

type Fixture = {
  // Required exactly when the SSOT exposes create for the table.
  create?: () => Promise<JsonBody>;
  // A fresh row the update/delete cases may consume, plus a valid full PUT body for it.
  seed: () => Promise<Seeded>;
};

let pool: Pool;
let appPool: Pool;
let server: http.Server;
let baseUrl = '';
let currentUser: AuthUser;

const request = makeApiClient(() => baseUrl);

const injectUser: express.RequestHandler = (req, _res, next) => {
  (req as express.Request & { user?: AuthUser }).user = currentUser;
  next();
};

let bizId: number;
let adminId: number;
let proId: number;
let otherProId: number;
let clientId: number;
let blockId: number;

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq}`;
}

function asUser(id: number, role: AuthUser['role']): AuthUser {
  return {
    id,
    username: `u${id}`,
    email: null,
    role,
    business_id: bizId,
    is_active: true,
    must_change_password: false,
  };
}

async function seedUser(role: AuthUser['role']): Promise<number> {
  const name = unique(`audit_${role.toLowerCase()}`);
  const r = await pool.query<{ id: string }>(
    `INSERT INTO auth.users
       (username, email, display_name, password_hash, password_salt, role, business_id)
     VALUES ($1, $2, $3, 'h', 's', $4, $5)
     RETURNING id`,
    [name, `${name}@test.local`, name, role, bizId],
  );
  return Number(r.rows[0].id);
}

async function seedService(): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
     VALUES ($1, $2, 30, '100.00') RETURNING id`,
    [bizId, unique('svc')],
  );
  return Number(r.rows[0].id);
}

async function seedResource(): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO resources (business_id, name) VALUES ($1, $2) RETURNING id`,
    [bizId, unique('room')],
  );
  return Number(r.rows[0].id);
}

async function seedBlock(): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO schedule_blocks (professional_user_id, weekday, start_time, end_time)
     VALUES ($1, 'mon', '09:00', '17:00') RETURNING id`,
    [proId],
  );
  return Number(r.rows[0].id);
}

// One entry per table the SSOT exposes for a generic write. Bodies carry the full editable
// column set because the validator accepts nothing missing and nothing extra.
const fixtures: Partial<Record<TableKey, Fixture>> = {
  resources: {
    create: async () => ({ name: unique('room'), description: null }),
    seed: async () => ({
      id: await seedResource(),
      update: { name: unique('room'), description: 'edited' },
    }),
  },

  services: {
    create: async () => ({
      name: unique('svc'),
      description: null,
      default_duration_minutes: 30,
      default_price_ars: '100.00',
    }),
    seed: async () => ({
      id: await seedService(),
      update: {
        name: unique('svc'),
        description: 'edited',
        default_duration_minutes: 45,
        default_price_ars: '150.00',
      },
    }),
  },

  client_professional_services: {
    create: async () => ({
      client_user_id: String(clientId),
      professional_user_id: String(proId),
      service_id: String(await seedService()),
      price_ars: '80.00',
    }),
    seed: async () => {
      const serviceId = await seedService();
      const r = await pool.query<{ id: string }>(
        `INSERT INTO client_professional_services
           (client_user_id, professional_user_id, service_id, price_ars)
         VALUES ($1, $2, $3, '80.00') RETURNING id`,
        [clientId, proId, serviceId],
      );
      return {
        id: Number(r.rows[0].id),
        update: {
          client_user_id: String(clientId),
          professional_user_id: String(proId),
          service_id: String(serviceId),
          price_ars: '95.00',
        },
      };
    },
  },

  professional_services: {
    create: async () => ({
      professional_user_id: String(proId),
      service_id: String(await seedService()),
      min_booking_days: 0,
      max_booking_days: null,
    }),
    seed: async () => {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO professional_services (professional_user_id, service_id)
         VALUES ($1, $2) RETURNING id`,
        [proId, await seedService()],
      );
      // The FK pair is readonlyOnEdit — only the booking window is updatable.
      return { id: Number(r.rows[0].id), update: { min_booking_days: 2, max_booking_days: 30 } };
    },
  },

  schedule_blocks: {
    create: async () => ({
      professional_user_id: String(proId),
      resource_id: null,
      weekday: 'tue',
      start_time: '09:00',
      end_time: '12:00',
    }),
    seed: async () => ({
      id: await seedBlock(),
      update: {
        professional_user_id: String(proId),
        resource_id: null,
        weekday: 'wed',
        start_time: '10:00',
        end_time: '13:00',
      },
    }),
  },

  schedule_block_services: {
    create: async () => ({
      professional_user_id: String(proId),
      schedule_block_id: String(blockId),
      service_id: String(await seedService()),
      duration_minutes: null,
      price_ars: null,
    }),
    seed: async () => {
      const serviceId = await seedService();
      const r = await pool.query<{ id: string }>(
        `INSERT INTO schedule_block_services (professional_user_id, schedule_block_id, service_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [proId, blockId, serviceId],
      );
      return {
        id: Number(r.rows[0].id),
        update: {
          professional_user_id: String(proId),
          schedule_block_id: String(blockId),
          service_id: String(serviceId),
          duration_minutes: 45,
          price_ars: '120.00',
        },
      };
    },
  },

  schedule_exceptions: {
    create: async () => ({
      professional_user_id: String(proId),
      resource_id: null,
      exception_date: futureDate(),
      is_unavailable: true,
      start_time: null,
      end_time: null,
      granularity_minutes: null,
      reason: null,
    }),
    seed: async () => {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO schedule_exceptions (professional_user_id, exception_date, is_unavailable)
         VALUES ($1, $2, true) RETURNING id`,
        [proId, futureDate()],
      );
      return {
        id: Number(r.rows[0].id),
        update: {
          professional_user_id: String(proId),
          resource_id: null,
          exception_date: futureDate(),
          is_unavailable: true,
          start_time: null,
          end_time: null,
          granularity_minutes: null,
          reason: 'edited',
        },
      };
    },
  },

  // Logical entities over auth.users: create is disabled (users are minted by the bespoke admin
  // route), so only update/delete are exercised here.
  clients: {
    seed: async () => ({
      id: await seedUser('Client'),
      update: { display_name: unique('cli'), dni: null, phone: null, notes: 'edited' },
    }),
  },

  professionals: {
    seed: async () => ({
      id: await seedUser('Professional'),
      update: { display_name: unique('pro'), bio: 'edited' },
    }),
  },
};

// Dates are relative so the suite never depends on a fixed calendar day.
function futureDate(): string {
  seq += 1;
  return new Date(Date.now() + (seq + 1) * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

async function auditRows(eventType: string, entityId: number) {
  const r = await pool.query<{
    entity_type: string;
    entity_id: string;
    actor_user_id: string;
    outcome: string;
    business_id: string;
  }>(
    `SELECT entity_type, entity_id, actor_user_id, outcome, business_id
       FROM audit_events
      WHERE event_type = $1 AND entity_id = $2`,
    [eventType, entityId],
  );
  return r.rows;
}

async function deniedRows(actorId: number) {
  const r = await pool.query<{ details: { path?: string; method?: string; reason?: string } }>(
    `SELECT details FROM audit_events
      WHERE event_type = 'permission_denied' AND outcome = 'denied' AND actor_user_id = $1`,
    [actorId],
  );
  return r.rows;
}

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const biz = await pool.query<{ id: string }>(
    `INSERT INTO businesses (name) VALUES ('Generic Audit Biz') RETURNING id`,
  );
  bizId = Number(biz.rows[0].id);

  adminId = await seedUser('Admin');
  proId = await seedUser('Professional');
  otherProId = await seedUser('Professional');
  clientId = await seedUser('Client');
  blockId = await seedBlock();

  const app = express();
  app.use(express.json());
  app.use(injectUser);
  // The server runs on the app role, so the generic path hits aida26_user's real grants —
  // including INSERT on the append-only audit_events.
  appPool = makeAppPool();
  mountGenericRoutes(app, appPool);

  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  currentUser = asUser(adminId, 'Admin');
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await appPool?.end();
  await pool?.end();
});

describe('the fixture set covers everything the SSOT exposes', () => {
  test('every generically exposed write op has a fixture', () => {
    const uncovered = EXPOSED_WRITES.filter(({ table, op }) => {
      const fixture = fixtures[table];
      if (!fixture) return true;
      return op === 'create' && !fixture.create;
    }).map(({ table, op }) => `${op} ${table}`);

    expect(uncovered).toEqual([]);
  });

  test('the derived op list is not empty (a broken derivation would vacuously pass)', () => {
    expect(EXPOSED_WRITES.length).toBeGreaterThan(0);
  });
});

describe('every generic create/update/delete writes an audit row', () => {
  for (const { table, op } of EXPOSED_WRITES) {
    test(`${op} ${table}`, async () => {
      currentUser = asUser(adminId, 'Admin');
      const fixture = fixtures[table];
      if (!fixture) throw new Error(`No fixture for ${table} (covered by the guard test above)`);

      let entityId: number;

      if (op === 'create') {
        if (!fixture.create) throw new Error(`No create fixture for ${table}`);
        const res = await request<{ id: string }>(`/api/${table}`, {
          method: 'POST',
          body: await fixture.create(),
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        entityId = Number(dataOf(res).id);
      } else if (op === 'update') {
        const seeded = await fixture.seed();
        const res = await request<{ id: string }>(`/api/${table}/${seeded.id}`, {
          method: 'PUT',
          body: seeded.update,
        });
        expect(res.status, JSON.stringify(res.body)).toBe(202);
        entityId = seeded.id;
      } else {
        const seeded = await fixture.seed();
        const res = await request<{ id: string }>(`/api/${table}/${seeded.id}`, {
          method: 'DELETE',
        });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        entityId = seeded.id;
      }

      const rows = await auditRows(crudEventType(table, op), entityId);
      expect(rows).toHaveLength(1);
      expect(rows[0].entity_type).toBe(table);
      expect(Number(rows[0].entity_id)).toBe(entityId);
      expect(Number(rows[0].actor_user_id)).toBe(adminId);
      expect(Number(rows[0].business_id)).toBe(bizId);
      expect(rows[0].outcome).toBe('success');
    });
  }
});

describe('generic-CRUD authorization denials are audited', () => {
  test('a role-denied delete records permission_denied', async () => {
    currentUser = asUser(clientId, 'Client');
    const serviceId = await seedService();

    const res = await request(`/api/services/${serviceId}`, { method: 'DELETE' });
    expect(res.status).toBe(403);

    const rows = await deniedRows(clientId);
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toMatchObject({
      path: `/api/services/${serviceId}`,
      method: 'DELETE',
      reason: 'forbidden',
    });
  });

  test('a schedule-guard denial on create records permission_denied', async () => {
    currentUser = asUser(otherProId, 'Professional');

    // A Professional may only touch their own schedule; proId's block is not theirs.
    const res = await request('/api/schedule_blocks', {
      method: 'POST',
      body: {
        professional_user_id: String(proId),
        resource_id: null,
        weekday: 'thu',
        start_time: '09:00',
        end_time: '12:00',
      },
    });
    expect(res.status).toBe(403);

    const rows = await deniedRows(otherProId);
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toMatchObject({
      path: '/api/schedule_blocks',
      method: 'POST',
      reason: 'forbidden',
    });
  });

  test('a denied write leaves no success event behind', async () => {
    const r = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events
        WHERE actor_user_id = $1 AND outcome = 'success'`,
      [otherProId],
    );
    expect(Number(r.rows[0].n)).toBe(0);
  });
});
