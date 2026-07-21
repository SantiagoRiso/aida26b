import http from 'node:http';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { app, pool } from '../src/server';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { hashPassword } from '../src/auth';
import type { Pool } from 'pg';
import { makeApiClient, dataOf } from './api_client';
import type {
  CalendarGrantCreatedRow,
  CalendarGrantRow,
  GenericRow,
  GrantableStaffRow,
} from '../../shared/src/ssot/query-types';

let testPool: Pool;

// The server module owns a module-level pool; point it at the per-run test database so the
// routes under test hit real grants instead of the developer's database.
function installTestProxy() {
  pool.query = testPool.query.bind(testPool);
  pool.connect = testPool.connect.bind(testPool);
}

let server: http.Server;
let baseUrl: string;

// Revoking answers with the deleted grant's id, not the row.
type RevokedGrantResult = { id: string; revoked: boolean };

const request = makeApiClient(() => baseUrl);

async function login(username: string, password: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  expect(response.status, `login ${username}`).toBe(200);
  const setCookie = response.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  return setCookie!.split(';')[0];
}

async function seedUser(
  businessId: string,
  username: string,
  role: string,
  _withProfile: boolean = false
) {
  const { passwordHash, passwordSalt } = await hashPassword('testpass1');
  const row = await testPool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6, $7, false) RETURNING id`,
    [username, `${username}@test.local`, username, passwordHash, passwordSalt, role, businessId]
  );
  return row.rows[0].id;
}

let bizId: string;
let otherBizId: string;

let adminCookie: string;
let p1Cookie: string;
let p2Cookie: string;
let receptionistCookie: string;
let clientCookie: string;

let p1UserId: string;
let p2UserId: string;
let receptionistUserId: string;
let clientUserId: string;

let otherBizProfUserId: string;

beforeAll(async () => {
  await resetTestDb();
  testPool = makeTestPool();
  installTestProxy();

  await runMigrations(testPool, DEFAULT_MIGRATIONS_DIR);

  const biz = await testPool.query<{ id: string }>(
    `INSERT INTO businesses (name) VALUES ('Test Biz') RETURNING id`
  );
  bizId = biz.rows[0].id;

  const otherBiz = await testPool.query<{ id: string }>(
    `INSERT INTO businesses (name) VALUES ('Other Biz') RETURNING id`
  );
  otherBizId = otherBiz.rows[0].id;

  await seedUser(bizId, 'admin1', 'Admin');
  p1UserId = await seedUser(bizId, 'p1user', 'Professional', true);
  p2UserId = await seedUser(bizId, 'p2user', 'Professional', true);
  receptionistUserId = await seedUser(bizId, 'recep1', 'Receptionist');
  clientUserId = await seedUser(bizId, 'client1', 'Client', true);

  const otherAdmin = await seedUser(otherBizId, 'otheradmin', 'Admin');
  otherBizProfUserId = await seedUser(otherBizId, 'otherpro', 'Professional', true);
  void otherAdmin; // used implicitly via the other-business grant seeded in "list" tests

  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;

  adminCookie = await login('admin1', 'testpass1');
  p1Cookie = await login('p1user', 'testpass1');
  p2Cookie = await login('p2user', 'testpass1');
  receptionistCookie = await login('recep1', 'testpass1');
  clientCookie = await login('client1', 'testpass1');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await testPool.end();
});

describe('Grant creation (POST /api/calendar-grants)', () => {
  test('P1 creates a grant for Receptionist on P1 own calendar → 201, binary row', async () => {
    const res = await request<CalendarGrantCreatedRow>('/api/calendar-grants', {
      method: 'POST',
      cookie: p1Cookie,
      body: { professional_user_id: p1UserId, grantee_user_id: receptionistUserId },
    });

    expect(res.status).toBe(201);
    const data = dataOf(res);
    expect(String(data.professional_user_id)).toBe(String(p1UserId));
    expect(String(data.grantee_user_id)).toBe(String(receptionistUserId));
    expect(data).not.toHaveProperty('view');
    expect(data).not.toHaveProperty('create');
    expect(data).not.toHaveProperty('edit');
    expect(data).not.toHaveProperty('cancel');

    const row = await testPool.query(
      `SELECT * FROM calendar_grants WHERE professional_user_id = $1 AND grantee_user_id = $2`,
      [p1UserId, receptionistUserId]
    );
    expect(row.rows).toHaveLength(1);
  });

  test('P1 attempts to create a grant on P2 calendar → 403', async () => {
    const res = await request<CalendarGrantCreatedRow>('/api/calendar-grants', {
      method: 'POST',
      cookie: p1Cookie,
      body: { professional_user_id: p2UserId, grantee_user_id: receptionistUserId },
    });
    expect(res.status).toBe(403);
  });

  test('Admin creates a grant on P2 calendar → 201', async () => {
    const res = await request<CalendarGrantCreatedRow>('/api/calendar-grants', {
      method: 'POST',
      cookie: adminCookie,
      body: { professional_user_id: p2UserId, grantee_user_id: receptionistUserId },
    });
    expect(res.status).toBe(201);
  });

  test('Receptionist attempts to create a grant → 403', async () => {
    const res = await request<CalendarGrantCreatedRow>('/api/calendar-grants', {
      method: 'POST',
      cookie: receptionistCookie,
      body: { professional_user_id: p1UserId, grantee_user_id: receptionistUserId },
    });
    expect(res.status).toBe(403);
  });

  test('Client attempts to create a grant → 403', async () => {
    const res = await request<CalendarGrantCreatedRow>('/api/calendar-grants', {
      method: 'POST',
      cookie: clientCookie,
      body: { professional_user_id: p1UserId, grantee_user_id: receptionistUserId },
    });
    expect(res.status).toBe(403);
  });

  test('Grantee that is a Client → 422 (staff-only grantee)', async () => {
    const res = await request<CalendarGrantCreatedRow>('/api/calendar-grants', {
      method: 'POST',
      cookie: adminCookie,
      body: { professional_user_id: p1UserId, grantee_user_id: clientUserId },
    });
    expect(res.status).toBe(422);
  });

  test('Grantee that is a Professional → allowed', async () => {
    const res = await request<CalendarGrantCreatedRow>('/api/calendar-grants', {
      method: 'POST',
      cookie: adminCookie,
      body: { professional_user_id: p1UserId, grantee_user_id: p2UserId },
    });
    // May be 201 (new) or 409 (already exists from a prior test run in same DB).
    expect([201, 409]).toContain(res.status);
  });

  test('Duplicate grant → 409 (UNIQUE constraint)', async () => {
    await request<CalendarGrantCreatedRow>('/api/calendar-grants', {
      method: 'POST',
      cookie: adminCookie,
      body: { professional_user_id: p2UserId, grantee_user_id: p1UserId },
    });

    const res = await request<CalendarGrantCreatedRow>('/api/calendar-grants', {
      method: 'POST',
      cookie: adminCookie,
      body: { professional_user_id: p2UserId, grantee_user_id: p1UserId },
    });
    expect(res.status).toBe(409);
  });

  test('Missing body fields → 400', async () => {
    const res = await request<CalendarGrantCreatedRow>('/api/calendar-grants', {
      method: 'POST',
      cookie: adminCookie,
      body: { professional_user_id: p1UserId },
    });
    expect(res.status).toBe(400);
  });
});

describe('Grant revocation (DELETE /api/calendar-grants/:id)', () => {
  let grantIdForP1Recep: string;
  let grantIdForAdminRevoke: string;

  beforeAll(async () => {
    await testPool.query(
      `DELETE FROM calendar_grants WHERE professional_user_id = $1 AND grantee_user_id = $2`,
      [p1UserId, receptionistUserId]
    );
    const row = await testPool.query<{ id: string }>(
      `INSERT INTO calendar_grants (professional_user_id, grantee_user_id)
       VALUES ($1, $2) RETURNING id`,
      [p1UserId, receptionistUserId]
    );
    grantIdForP1Recep = row.rows[0].id;

    await testPool.query(
      `DELETE FROM calendar_grants WHERE professional_user_id = $1 AND grantee_user_id = $2`,
      [p2UserId, p1UserId]
    );
    const row2 = await testPool.query<{ id: string }>(
      `INSERT INTO calendar_grants (professional_user_id, grantee_user_id)
       VALUES ($1, $2) RETURNING id`,
      [p2UserId, p1UserId]
    );
    grantIdForAdminRevoke = row2.rows[0].id;
  });

  test('P1 revokes their own grant → 200 and row is gone', async () => {
    const res = await request<RevokedGrantResult>(`/api/calendar-grants/${grantIdForP1Recep}`, {
      method: 'DELETE',
      cookie: p1Cookie,
    });
    expect(res.status).toBe(200);

    const row = await testPool.query(
      `SELECT 1 FROM calendar_grants WHERE id = $1`,
      [grantIdForP1Recep]
    );
    expect(row.rows).toHaveLength(0);
  });

  test('P1 attempts to revoke a grant on P2 calendar → 403', async () => {
    const res = await request<RevokedGrantResult>(`/api/calendar-grants/${grantIdForAdminRevoke}`, {
      method: 'DELETE',
      cookie: p1Cookie,
    });
    expect(res.status).toBe(403);
  });

  test('Admin revokes any in-business grant → 200 and row is gone', async () => {
    const res = await request<RevokedGrantResult>(`/api/calendar-grants/${grantIdForAdminRevoke}`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    expect(res.status).toBe(200);

    const row = await testPool.query(
      `SELECT 1 FROM calendar_grants WHERE id = $1`,
      [grantIdForAdminRevoke]
    );
    expect(row.rows).toHaveLength(0);
  });

  test('Revoke non-existent grant → 404', async () => {
    const res = await request<RevokedGrantResult>(`/api/calendar-grants/999999`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    expect(res.status).toBe(404);
  });

  test('Receptionist attempts to revoke → 403', async () => {
    const row = await testPool.query<{ id: string }>(
      `INSERT INTO calendar_grants (professional_user_id, grantee_user_id)
       VALUES ($1, $2) RETURNING id`,
      [p1UserId, receptionistUserId]
    );
    const throwawayId = row.rows[0].id;

    const res = await request<RevokedGrantResult>(`/api/calendar-grants/${throwawayId}`, {
      method: 'DELETE',
      cookie: receptionistCookie,
    });
    expect(res.status).toBe(403);

    await testPool.query(`DELETE FROM calendar_grants WHERE id = $1`, [throwawayId]);
  });
});

describe('Grant listing (GET /api/calendar-grants)', () => {
  let crossBizGrantId: string;

  beforeAll(async () => {
    await testPool.query('DELETE FROM calendar_grants');

    await testPool.query(
      `INSERT INTO calendar_grants (professional_user_id, grantee_user_id) VALUES ($1, $2)`,
      [p1UserId, receptionistUserId]
    );
    await testPool.query(
      `INSERT INTO calendar_grants (professional_user_id, grantee_user_id) VALUES ($1, $2)`,
      [p2UserId, receptionistUserId]
    );

    const row = await testPool.query<{ id: string }>(
      `INSERT INTO calendar_grants (professional_user_id, grantee_user_id) VALUES ($1, $2) RETURNING id`,
      [otherBizProfUserId, otherBizProfUserId]
    );
    crossBizGrantId = row.rows[0].id;
    void crossBizGrantId; // used implicitly via the assertion below
  });

  test('Admin sees all in-business grants (2 rows)', async () => {
    const res = await request<CalendarGrantRow[]>('/api/calendar-grants', { cookie: adminCookie });
    expect(res.status).toBe(200);
    const data = dataOf(res);
    expect(data).toHaveLength(2);
  });

  test('P1 sees only their own calendar grants (1 row)', async () => {
    const res = await request<CalendarGrantRow[]>('/api/calendar-grants', { cookie: p1Cookie });
    expect(res.status).toBe(200);
    const data = dataOf(res);
    expect(data).toHaveLength(1);
    expect(String(data[0].professional_user_id)).toBe(String(p1UserId));
  });

  test('P2 sees only their own calendar grants (1 row)', async () => {
    const res = await request<CalendarGrantRow[]>('/api/calendar-grants', { cookie: p2Cookie });
    expect(res.status).toBe(200);
    const data = dataOf(res);
    expect(data).toHaveLength(1);
  });

  test('Client cannot list grants → 403 (staff-internal data)', async () => {
    const res = await request<CalendarGrantRow[]>('/api/calendar-grants', { cookie: clientCookie });
    expect(res.status).toBe(403);
  });

  test('Cross-business grants are never returned to main-biz admin', async () => {
    const res = await request<CalendarGrantRow[]>('/api/calendar-grants', { cookie: adminCookie });
    expect(res.status).toBe(200);
    const data = dataOf(res);
    const ids = data.map((g) => String(g.professional_user_id));
    expect(ids).not.toContain(String(otherBizProfUserId));
  });

  test('Receptionist can list in-business grants (read allowed)', async () => {
    const res = await request<CalendarGrantRow[]>('/api/calendar-grants', { cookie: receptionistCookie });
    expect(res.status).toBe(200);
    const data = dataOf(res);
    expect(data).toHaveLength(2);
  });

  test('Admin can filter by professional_user_id query param', async () => {
    const res = await request<CalendarGrantRow[]>(
      `/api/calendar-grants?professional_user_id=${p1UserId}`,
      { cookie: adminCookie }
    );
    expect(res.status).toBe(200);
    const data = dataOf(res);
    expect(data).toHaveLength(1);
    expect(String(data[0].professional_user_id)).toBe(String(p1UserId));
  });

  test('Listed grants are enriched with grantee_username, grantee_role, professional_name', async () => {
    const res = await request<CalendarGrantRow[]>(
      `/api/calendar-grants?professional_user_id=${p1UserId}`,
      { cookie: adminCookie }
    );
    expect(res.status).toBe(200);
    const data = dataOf(res);
    expect(data).toHaveLength(1);
    expect(data[0].grantee_username).toBe('recep1');
    expect(data[0].grantee_role).toBe('Receptionist');
    // seedUser sets display_name = username.
    expect(data[0].professional_name).toBe('p1user');
  });
});

describe('Grantable staff listing (GET /api/calendar-grants/grantable-staff)', () => {
  test('Admin sees the business\'s Receptionists + Professionals, not Clients or Admins', async () => {
    const res = await request<GrantableStaffRow[]>('/api/calendar-grants/grantable-staff', { cookie: adminCookie });
    expect(res.status).toBe(200);
    const data = dataOf(res);
    const ids = data.map((r) => String(r.id));
    expect(ids.sort()).toEqual([String(p1UserId), String(p2UserId), String(receptionistUserId)].sort());
    expect(ids).not.toContain(String(clientUserId));
    expect(data.every((r) => r.role === 'Receptionist' || r.role === 'Professional')).toBe(true);
  });

  test('Professional sees the same staff set as Admin (own-calendar grant management)', async () => {
    const res = await request<GrantableStaffRow[]>('/api/calendar-grants/grantable-staff', { cookie: p1Cookie });
    expect(res.status).toBe(200);
    const data = dataOf(res);
    expect(data).toHaveLength(3);
  });

  test('Cross-business staff are never returned', async () => {
    const res = await request<GrantableStaffRow[]>('/api/calendar-grants/grantable-staff', { cookie: adminCookie });
    expect(res.status).toBe(200);
    const data = dataOf(res);
    expect(data.map((r) => String(r.id))).not.toContain(String(otherBizProfUserId));
  });

  test('Receptionist → 403', async () => {
    const res = await request<GrantableStaffRow[]>('/api/calendar-grants/grantable-staff', { cookie: receptionistCookie });
    expect(res.status).toBe(403);
  });

  test('Client → 403', async () => {
    const res = await request<GrantableStaffRow[]>('/api/calendar-grants/grantable-staff', { cookie: clientCookie });
    expect(res.status).toBe(403);
  });
});

// Generic CRUD on professionals is grant-scoped for receptionists: their world is
// the calendars they were granted. Everyone else stays unscoped.
describe('Grant scoping of professionals (generic CRUD)', () => {
  beforeAll(async () => {
    await testPool.query('DELETE FROM calendar_grants');
    // Grant only P1 to the receptionist; P2 stays ungranted.
    await testPool.query(
      `INSERT INTO calendar_grants (professional_user_id, grantee_user_id) VALUES ($1, $2)`,
      [p1UserId, receptionistUserId]
    );
  });

  test('Receptionist lists professionals → only granted (P1)', async () => {
    const res = await request<GenericRow[]>('/api/professionals', { cookie: receptionistCookie });
    expect(res.status).toBe(200);
    const data = dataOf(res);
    expect(data).toHaveLength(1);
    expect(String(data[0].id)).toBe(String(p1UserId));
  });

  test('Receptionist gets a granted professional by id → 200', async () => {
    const res = await request<GenericRow>(`/api/professionals?id=${p1UserId}`, { cookie: receptionistCookie });
    expect(res.status).toBe(200);
    const data = dataOf(res);
    expect(String(data.id)).toBe(String(p1UserId));
  });

  test('Receptionist gets an ungranted professional by id → 404, not 403', async () => {
    const res = await request<GenericRow>(`/api/professionals?id=${p2UserId}`, { cookie: receptionistCookie });
    expect(res.status).toBe(404);
  });

  test('Admin lists professionals → all in business (unscoped)', async () => {
    const res = await request<GenericRow[]>('/api/professionals', { cookie: adminCookie });
    expect(res.status).toBe(200);
    const data = dataOf(res);
    const ids = data.map((p) => String(p.id));
    expect(ids).toContain(String(p1UserId));
    expect(ids).toContain(String(p2UserId));
  });

  test('Client lists professionals → all in business (portal booking depends on this)', async () => {
    const res = await request<GenericRow[]>('/api/professionals', { cookie: clientCookie });
    expect(res.status).toBe(200);
    const data = dataOf(res);
    const ids = data.map((p) => String(p.id));
    expect(ids).toContain(String(p1UserId));
    expect(ids).toContain(String(p2UserId));
  });
});
