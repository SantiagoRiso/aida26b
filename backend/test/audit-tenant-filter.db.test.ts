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
import { filterParam } from '../../shared/src/ssot/list-protocol';
import type { AuditEventRow, Wire } from '../../shared/src/ssot/query-types';

// Two linked properties of the audit list: (A) a super-admin's cross-tenant read carries a
// business_id column (null for tenantless system events) while a tenant Admin's projection is
// unchanged; (B) filters travel under the shared `filter_` grammar, allowlisted to the endpoint's
// own field names, every value a bind parameter.

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
let superAdminId: number;

const A_EVENT = 'tf_tenant_a';
const B_EVENT = 'tf_tenant_b';
const TENANTLESS_EVENT = 'tf_login_failed_unknown';

function asUser(id: number, role: AuthUser['role'], bId: number | null): AuthUser {
  return { id, username: `u${id}`, email: null, role, business_id: bId, is_active: true, must_change_password: false };
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
    `INSERT INTO businesses (name, cancellation_cutoff_hours) VALUES ('TF A', 24) RETURNING id`,
  );
  bizAId = Number(bizA.rows[0].id);
  const bizB = await pool.query<{ id: string }>(
    `INSERT INTO businesses (name, cancellation_cutoff_hours) VALUES ('TF B', 24) RETURNING id`,
  );
  bizBId = Number(bizB.rows[0].id);

  adminAId = await seedUser('tf_admin_a', 'Admin', bizAId);
  const adminBId = await seedUser('tf_admin_b', 'Admin', bizBId);
  superAdminId = await seedUser('tf_super', 'Admin', null);

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

describe('(A) the tenant column is a super-admin projection', () => {
  test('a super-admin read carries business_id, matching each row\'s tenant', async () => {
    const { rows } = await listAs(asUser(superAdminId, 'Admin', null), '?limit=500');
    const a = rows.find((r) => r.event_type === A_EVENT);
    const b = rows.find((r) => r.event_type === B_EVENT);
    expect(a?.business_id).toBe(String(bizAId));
    expect(b?.business_id).toBe(String(bizBId));
  });

  test('a tenantless system event carries a null business_id — the "Sistema" marker\'s source', async () => {
    const { rows } = await listAs(asUser(superAdminId, 'Admin', null), '?limit=500');
    const tenantless = rows.find((r) => r.event_type === TENANTLESS_EVENT);
    expect(tenantless).toBeDefined();
    expect(tenantless?.business_id).toBeNull();
  });

  test('a tenant Admin\'s projection omits business_id entirely — its payload is unchanged', async () => {
    const { rows } = await listAs(asUser(adminAId, 'Admin', bizAId), '?limit=500');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect('business_id' in row).toBe(false);
  });

  test('a tenant Admin still sees only its own tenant, never the merged stream', async () => {
    const { rows } = await listAs(asUser(adminAId, 'Admin', bizAId), '?limit=500');
    const types = rows.map((r) => r.event_type);
    for (const t of types) expect(t).toBe(A_EVENT);
    expect(types).not.toContain(B_EVENT);
    expect(types).not.toContain(TENANTLESS_EVENT);
  });
});

describe('(B) filters speak the shared filter_ grammar', () => {
  test('an identity filter narrows the super-admin read to the matching outcome', async () => {
    const { rows, total } = await listAs(
      asUser(superAdminId, 'Admin', null),
      `?${filterParam('outcome')}=denied&limit=500`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.outcome).toBe('denied');
    expect(total).toBe(rows.length);
  });

  test('a created_at range narrows to the window and back out again', async () => {
    const from = new Date(Date.now() - 60 * 1000).toISOString();
    const to = new Date(Date.now() + 60 * 1000).toISOString();
    const inWindow = await listAs(
      asUser(superAdminId, 'Admin', null),
      `?${filterParam('created_at')}=${encodeURIComponent(from)},${encodeURIComponent(to)}&limit=500`,
    );
    expect(inWindow.rows.length).toBeGreaterThan(0);

    const past = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString();
    const beforeSeed = await listAs(
      asUser(superAdminId, 'Admin', null),
      `?${filterParam('created_at')}=,${encodeURIComponent(past)}&limit=500`,
    );
    expect(beforeSeed.rows).toHaveLength(0);
  });

  test('a filter field outside the endpoint allowlist is dropped, not honoured', async () => {
    // business_id is a real column but not a declared audit filter field: naming it must not scope
    // the read (which would be a way to forge cross-tenant narrowing), so the result is unchanged.
    const unfiltered = await listAs(asUser(superAdminId, 'Admin', null), '?limit=500');
    const withHostileField = await listAs(
      asUser(superAdminId, 'Admin', null),
      `?${filterParam('business_id')}=${bizBId}&limit=500`,
    );
    expect(withHostileField.total).toBe(unfiltered.total);
  });

  test('a filter field name carrying SQL is dropped without executing', async () => {
    currentUser = asUser(superAdminId, 'Admin', null);
    const hostile = filterParam('id"); DROP TABLE audit_events; --');
    const res = await request<AuditRow[]>(`/api/audit?${encodeURIComponent(hostile)}=1&limit=500`, { method: 'GET' });
    expect(res.status).toBe(200);
    const still = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_events`);
    expect(Number(still.rows[0].n)).toBeGreaterThan(0);
  });

  test('a filter value carrying SQL is bound, matching nothing rather than executing', async () => {
    const payload = "appointments'); DROP TABLE audit_events; --";
    const { rows } = await listAs(
      asUser(superAdminId, 'Admin', null),
      `?${filterParam('entity_type')}=${encodeURIComponent(payload)}&limit=500`,
    );
    expect(rows).toHaveLength(0);
    const still = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_events`);
    expect(Number(still.rows[0].n)).toBeGreaterThan(0);
  });
});
