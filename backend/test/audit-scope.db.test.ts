import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool, makeAppPool } from './helpers';
import { mountAuditRoutes } from '../src/routes/audit';
import type { AuthUser } from '../src/auth';
import { makeApiClient, dataOf, metaOf } from './api_client';
import type { AuditEventRow, Wire } from '../../shared/src/ssot/query-types';

let pool: Pool;
let appPool: Pool;
let server: http.Server;
let baseUrl: string;
let currentUser: AuthUser;

const injectUser: express.RequestHandler = (req, _res, next) => {
  (req as express.Request & { user?: AuthUser }).user = currentUser;
  next();
};

type AuditRow = Wire<AuditEventRow>;

const request = makeApiClient(() => baseUrl);

let bizAId: number;
let bizBId: number;
let adminAId: number;
let adminBId: number;
let superAdminId: number;
let proAId: number;

// Event types stand in for identity: the list projection carries no business_id, so a marker is
// the only way a test can say which tenant a returned row came from.
const A_EVENT = 'scope_probe_tenant_a';
const B_EVENT = 'scope_probe_tenant_b';
const TENANTLESS_EVENT = 'login_failed_unknown_username';
const TIE_EVENT = 'scope_probe_tie';

function asUser(id: number, role: AuthUser['role'], bId: number | null): AuthUser {
  return {
    id,
    username: `u${id}`,
    email: null,
    role,
    business_id: bId,
    is_active: true,
    must_change_password: false,
  };
}

async function seedUser(username: string, role: AuthUser['role'], bId: number | null): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO auth.users
       (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ($1, $2, $3, 'h', 's', $4, $5, false)
     RETURNING id`,
    [username, `${username}@test.local`, username, role, bId],
  );
  return Number(r.rows[0].id);
}

async function listAs(user: AuthUser, qs = ''): Promise<{ rows: AuditRow[]; total: number }> {
  currentUser = user;
  const res = await request<AuditRow[]>(`/api/audit${qs}`, { method: 'GET' });
  expect(res.status).toBe(200);
  return { rows: dataOf(res), total: metaOf(res).total };
}

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const bizA = await pool.query<{ id: string }>(
    `INSERT INTO businesses (name, cancellation_cutoff_hours) VALUES ('Tenant A', 24) RETURNING id`,
  );
  bizAId = Number(bizA.rows[0].id);
  const bizB = await pool.query<{ id: string }>(
    `INSERT INTO businesses (name, cancellation_cutoff_hours) VALUES ('Tenant B', 24) RETURNING id`,
  );
  bizBId = Number(bizB.rows[0].id);

  adminAId = await seedUser('scope_admin_a', 'Admin', bizAId);
  adminBId = await seedUser('scope_admin_b', 'Admin', bizBId);
  proAId = await seedUser('scope_pro_a', 'Professional', bizAId);
  superAdminId = await seedUser('scope_super_admin', 'Admin', null);

  await pool.query(
    `INSERT INTO audit_events
       (business_id, actor_user_id, event_type, entity_type, entity_id, outcome, details)
     VALUES
       ($1, $3, $5, 'appointments', 10, 'success', '{}'),
       ($1, $3, $5, 'appointments', 11, 'denied',  '{}'),
       ($2, $4, $6, 'appointments', 12, 'success', '{}'),
       (null, null, $7, null, null, 'failure', '{"username":"nobody"}')`,
    [bizAId, bizBId, adminAId, adminBId, A_EVENT, B_EVENT, TENANTLESS_EVENT],
  );

  const app = express();
  app.use(express.json());
  appPool = makeAppPool();
  mountAuditRoutes(app, appPool, {
    auth: injectUser,
    passwordReady: ((_req, _res, next) => next()) as express.RequestHandler,
    audit: async () => {},
  });

  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  currentUser = asUser(adminAId, 'Admin', bizAId);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await appPool.end();
  await pool.end();
});

describe('GET /api/audit — tenant Admin scope', () => {
  test('sees only own-tenant rows', async () => {
    const { rows, total } = await listAs(asUser(adminAId, 'Admin', bizAId), '?limit=500');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.event_type).toBe(A_EVENT);
    expect(total).toBe(rows.length);
  });

  test('never sees another tenant\'s rows', async () => {
    const { rows } = await listAs(asUser(adminAId, 'Admin', bizAId), '?limit=500');
    expect(rows.map((r) => r.event_type)).not.toContain(B_EVENT);
  });

  test('never sees tenantless rows — an attempt on the system is not an event of their tenant', async () => {
    const { rows, total } = await listAs(asUser(adminAId, 'Admin', bizAId), `?filter_event_type=${TENANTLESS_EVENT}`);
    expect(rows).toHaveLength(0);
    expect(total).toBe(0);
  });

  test('filtering by another tenant\'s actor yields nothing, not that tenant\'s rows', async () => {
    const { rows, total } = await listAs(asUser(adminAId, 'Admin', bizAId), `?filter_actor_user_id=${adminBId}`);
    expect(rows).toHaveLength(0);
    expect(total).toBe(0);
  });

  test('the other tenant\'s Admin sees the mirror image', async () => {
    const { rows } = await listAs(asUser(adminBId, 'Admin', bizBId), '?limit=500');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.event_type).toBe(B_EVENT);
  });
});

describe('GET /api/audit — super-admin scope', () => {
  test('a null-business Admin is served, not refused for lacking a business', async () => {
    currentUser = asUser(superAdminId, 'Admin', null);
    const res = await request<AuditRow[]>('/api/audit', { method: 'GET' });
    expect(res.status).toBe(200);
  });

  test('reads across tenants and the tenantless rows in one list', async () => {
    const { rows } = await listAs(asUser(superAdminId, 'Admin', null), '?limit=500');
    const types = rows.map((r) => r.event_type);
    expect(types).toContain(A_EVENT);
    expect(types).toContain(B_EVENT);
    expect(types).toContain(TENANTLESS_EVENT);
  });

  test('meta.total counts every tenant, not just one', async () => {
    const a = await listAs(asUser(adminAId, 'Admin', bizAId), '?limit=500');
    const b = await listAs(asUser(adminBId, 'Admin', bizBId), '?limit=500');
    const all = await listAs(asUser(superAdminId, 'Admin', null), '?limit=500');
    expect(all.total).toBeGreaterThan(a.total + b.total);
  });

  test('filters still narrow an unscoped read', async () => {
    const { rows, total } = await listAs(asUser(superAdminId, 'Admin', null), `?filter_event_type=${TENANTLESS_EVENT}`);
    expect(rows.length).toBe(1);
    expect(total).toBe(1);
    expect(rows[0].outcome).toBe('failure');
  });

  test('a non-Admin is refused before scope is resolved, so no role can inherit the wide read', async () => {
    currentUser = asUser(proAId, 'Professional', null);
    const res = await request<AuditRow[]>('/api/audit', { method: 'GET' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/audit — created_at ties are broken by id', () => {
  beforeAll(async () => {
    // Events written in one transaction share created_at; without the id tiebreaker a page boundary
    // can repeat one row and drop another.
    await pool.query(
      `INSERT INTO audit_events
         (business_id, actor_user_id, event_type, entity_type, outcome, details, created_at)
       SELECT $1, $2, $3, 'appointments', 'success', '{}', now()
         FROM generate_series(1, 3)`,
      [bizAId, adminAId, TIE_EVENT],
    );
  });

  test('tied rows come back newest id first', async () => {
    const { rows } = await listAs(asUser(adminAId, 'Admin', bizAId), `?filter_event_type=${TIE_EVENT}&limit=500`);
    expect(rows).toHaveLength(3);
    const ids = rows.map((r) => Number(r.id));
    expect(ids).toEqual([...ids].sort((x, y) => y - x));
  });

  test('paging one tied row at a time never repeats or skips one', async () => {
    const seen: number[] = [];
    for (const page of [1, 2, 3]) {
      const { rows } = await listAs(
        asUser(adminAId, 'Admin', bizAId),
        `?filter_event_type=${TIE_EVENT}&limit=1&page=${page}`,
      );
      expect(rows).toHaveLength(1);
      seen.push(Number(rows[0].id));
    }
    expect(new Set(seen).size).toBe(3);
  });
});
