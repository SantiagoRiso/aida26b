import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { mountGenericRoutes } from '../src/app';
import type { AuthUser } from '../src/auth';

// Exercises the own-schedule guard through the generic write path (post.ts) — a
// schedule_exceptions create targeting a professional — across every role/grant combination.
let pool: Pool;
let server: http.Server;
let baseUrl: string;
let currentUser: AuthUser;

const injectUser: express.RequestHandler = (req, _res, next) => {
  (req as express.Request & { user?: AuthUser }).user = currentUser;
  next();
};

async function createException(professionalUserId: number, exceptionDate: string) {
  const response = await fetch(`${baseUrl}/api/schedule_exceptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Generic writes are full-object: every editable column must be present (nullable ones as null).
    // FK ids are declared type 'string' in the SSOT.
    body: JSON.stringify({
      professional_user_id: String(professionalUserId),
      resource_id: null,
      exception_date: exceptionDate,
      is_unavailable: true,
      start_time: null,
      end_time: null,
      granularity_minutes: null,
      reason: null,
    }),
  });
  return response.status;
}

let bizId: string;
let pro1: number;
let pro2: number;
let recepNoGrant: number;
let recepWithGrant: number;
let clientId: number;
let block1: string;
let block2: string;
const svc: number[] = [];

async function seedUser(username: string, role: string): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ($1, $2, $3, 'h', 's', $4, $5, false) RETURNING id`,
    [username, `${username}@test.local`, username, role, bizId]
  );
  return Number(r.rows[0].id);
}

const asUser = (id: number, role: AuthUser['role']): AuthUser => ({
  id,
  username: `u${id}`,
  email: null,
  role,
  business_id: Number(bizId),
  is_active: true,
  must_change_password: false,
});

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const biz = await pool.query<{ id: string }>(`INSERT INTO businesses (name) VALUES ('Authz Biz') RETURNING id`);
  bizId = biz.rows[0].id;

  pro1 = await seedUser('osa_pro1', 'Professional');
  pro2 = await seedUser('osa_pro2', 'Professional');
  recepNoGrant = await seedUser('osa_recep_no', 'Receptionist');
  recepWithGrant = await seedUser('osa_recep_yes', 'Receptionist');
  clientId = await seedUser('osa_client', 'Client');

  await pool.query(`INSERT INTO calendar_grants (professional_user_id, grantee_user_id) VALUES ($1, $2)`, [
    pro1,
    recepWithGrant,
  ]);

  // Distinct services so per-block (block_id, service_id) uniqueness doesn't collide across cases.
  for (let i = 0; i < 5; i++) {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
       VALUES ($1, $2, 30, '1000.00') RETURNING id`,
      [bizId, `osa_svc${i}`],
    );
    svc.push(Number(r.rows[0].id));
  }
  const b1 = await pool.query<{ id: string }>(
    `INSERT INTO schedule_blocks (professional_user_id, weekday, start_time, end_time)
     VALUES ($1, 'mon', '08:00', '18:00') RETURNING id`,
    [pro1],
  );
  block1 = b1.rows[0].id;
  const b2 = await pool.query<{ id: string }>(
    `INSERT INTO schedule_blocks (professional_user_id, weekday, start_time, end_time)
     VALUES ($1, 'tue', '08:00', '18:00') RETURNING id`,
    [pro2],
  );
  block2 = b2.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use(injectUser);
  mountGenericRoutes(app, pool);

  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('own-schedule authz via generic schedule_exceptions create', () => {
  test('Admin may create an exception for any in-business professional', async () => {
    currentUser = asUser(100000, 'Admin');
    expect(await createException(pro1, '2026-07-06')).toBe(201);
  });

  test('a Professional may create an exception on their OWN calendar', async () => {
    currentUser = asUser(pro1, 'Professional');
    expect(await createException(pro1, '2026-07-07')).toBe(201);
  });

  test('a Professional may NOT create an exception on a peer professional', async () => {
    currentUser = asUser(pro1, 'Professional');
    expect(await createException(pro2, '2026-07-08')).toBe(403);
  });

  test('a Receptionist WITHOUT a grant is forbidden', async () => {
    currentUser = asUser(recepNoGrant, 'Receptionist');
    expect(await createException(pro1, '2026-07-09')).toBe(403);
  });

  test('a Receptionist WITH a calendar grant for that professional succeeds', async () => {
    currentUser = asUser(recepWithGrant, 'Receptionist');
    expect(await createException(pro1, '2026-07-10')).toBe(201);
  });

  test('a Client can never create a schedule exception', async () => {
    currentUser = asUser(clientId, 'Client');
    expect(await createException(pro1, '2026-07-11')).toBe(403);
  });

  test('a DATE column is emitted verbatim as YYYY-MM-DD, not an ISO timestamp', async () => {
    currentUser = asUser(100000, 'Admin');
    const res = await fetch(`${baseUrl}/api/schedule_exceptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        professional_user_id: String(pro1), resource_id: null, exception_date: '2026-08-03',
        is_unavailable: true, start_time: null, end_time: null, granularity_minutes: null, reason: null,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { exception_date: string } };
    // A JS Date would serialise to '2026-08-03T00:00:00.000Z'; the wire must stay a bare date.
    expect(body.data.exception_date).toBe('2026-08-03');
  });

  test('a Professional cannot reassign their own exception to a peer via PUT (CR-01)', async () => {
    currentUser = asUser(pro1, 'Professional');
    const createRes = await fetch(`${baseUrl}/api/schedule_exceptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        professional_user_id: String(pro1), resource_id: null, exception_date: '2026-07-20',
        is_unavailable: true, start_time: null, end_time: null, granularity_minutes: null, reason: null,
      }),
    });
    expect(createRes.status).toBe(201);
    const id = ((await createRes.json()) as { data: { id: string } }).data.id;

    // Reassigning the owner to a peer must be rejected — owner is identity, not editable.
    const putRes = await fetch(`${baseUrl}/api/schedule_exceptions/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        professional_user_id: String(pro2), resource_id: null, exception_date: '2026-07-20',
        is_unavailable: true, start_time: null, end_time: null, granularity_minutes: null, reason: null,
      }),
    });
    expect(putRes.status).toBe(403);
  });
});

// schedule_block_services declares ownership/grantScope but is not an owner-scheduled table, so its
// create had no WHERE to scope and slipped the guard entirely. The professionalOwnerGuard closes it.
async function createBlockService(professionalUserId: number, blockId: string, serviceId: number) {
  const response = await fetch(`${baseUrl}/api/schedule_block_services`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      professional_user_id: String(professionalUserId),
      schedule_block_id: blockId,
      service_id: String(serviceId),
      duration_minutes: null,
      price_ars: null,
    }),
  });
  return response.status;
}

describe('own-schedule authz via generic schedule_block_services create/update', () => {
  test('Admin may attach a service to any in-business block', async () => {
    currentUser = asUser(100000, 'Admin');
    expect(await createBlockService(pro1, block1, svc[0])).toBe(201);
  });

  test('a Professional may attach a service to their OWN block', async () => {
    currentUser = asUser(pro1, 'Professional');
    expect(await createBlockService(pro1, block1, svc[1])).toBe(201);
  });

  test('a Professional may NOT attach a service to a peer\'s block', async () => {
    currentUser = asUser(pro1, 'Professional');
    expect(await createBlockService(pro2, block2, svc[0])).toBe(403);
  });

  test('a Receptionist WITHOUT a grant is forbidden', async () => {
    currentUser = asUser(recepNoGrant, 'Receptionist');
    expect(await createBlockService(pro1, block1, svc[2])).toBe(403);
  });

  test('a Receptionist WITH a grant for that professional succeeds', async () => {
    currentUser = asUser(recepWithGrant, 'Receptionist');
    expect(await createBlockService(pro1, block1, svc[2])).toBe(201);
  });

  test('a Client can never attach a block service', async () => {
    currentUser = asUser(clientId, 'Client');
    expect(await createBlockService(pro1, block1, svc[3])).toBe(403);
  });

  test('a Professional cannot reassign their own block service to a peer via PUT', async () => {
    currentUser = asUser(pro1, 'Professional');
    const createRes = await fetch(`${baseUrl}/api/schedule_block_services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        professional_user_id: String(pro1), schedule_block_id: block1, service_id: String(svc[4]),
        duration_minutes: null, price_ars: null,
      }),
    });
    expect(createRes.status).toBe(201);
    const id = ((await createRes.json()) as { data: { id: string } }).data.id;

    const putRes = await fetch(`${baseUrl}/api/schedule_block_services/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        professional_user_id: String(pro2), schedule_block_id: block1, service_id: String(svc[4]),
        duration_minutes: null, price_ars: null,
      }),
    });
    expect(putRes.status).toBe(403);
  });
});
