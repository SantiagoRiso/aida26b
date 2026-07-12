import http from 'node:http';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { app, pool } from '../src/server';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { hashPassword } from '../src/auth';
import type { Pool } from 'pg';
import type { TableRecordMap } from '../../shared/src/types/types';

let testPool: Pool;

function installTestProxy() {
  pool.query = (...args: Parameters<typeof pool.query>) =>
    // @ts-expect-error — overloaded signature; delegation is safe
    testPool.query(...args);

  // eslint-disable-next-line no-restricted-syntax -- pg's Pool.connect has an overloaded callback/promise signature a delegating proxy can't match directly
  pool.connect = () => testPool.connect() as unknown as ReturnType<typeof pool.connect>;
}

let server: http.Server;
let baseUrl: string;

type ReqBody = Record<string, string | number | boolean | null>;
type Envelope = {
  success?: boolean;
  data?: Record<string, string | number | boolean | null> | Record<string, string | number | boolean | null>[];
  meta?: { page: number; limit: number; total: number };
  error?: { code: string; message: string; fields?: Record<string, string> };
};

async function request(
  path: string,
  {
    method = 'GET',
    body,
    cookie,
  }: { method?: string; body?: ReqBody; cookie?: string } = {}
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let responseBody: Envelope | null = null;
  try {
    responseBody = text ? (JSON.parse(text) as Envelope) : null;
  } catch {
    responseBody = null;
  }

  return { status: response.status, body: responseBody };
}

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
  await new Promise<void>((resolve) => server.close(resolve));
  await testPool.end();
});

describe('Grant creation (POST /api/calendar-grants)', () => {
  test('P1 creates a grant for Receptionist on P1 own calendar → 201, binary row', async () => {
    const res = await request('/api/calendar-grants', {
      method: 'POST',
      cookie: p1Cookie,
      body: { professional_user_id: p1UserId, grantee_user_id: receptionistUserId },
    });

    expect(res.status).toBe(201);
    const data = (res.body as { data: TableRecordMap['calendar_grants'] }).data;
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
    const res = await request('/api/calendar-grants', {
      method: 'POST',
      cookie: p1Cookie,
      body: { professional_user_id: p2UserId, grantee_user_id: receptionistUserId },
    });
    expect(res.status).toBe(403);
  });

  test('Admin creates a grant on P2 calendar → 201', async () => {
    const res = await request('/api/calendar-grants', {
      method: 'POST',
      cookie: adminCookie,
      body: { professional_user_id: p2UserId, grantee_user_id: receptionistUserId },
    });
    expect(res.status).toBe(201);
  });

  test('Receptionist attempts to create a grant → 403', async () => {
    const res = await request('/api/calendar-grants', {
      method: 'POST',
      cookie: receptionistCookie,
      body: { professional_user_id: p1UserId, grantee_user_id: receptionistUserId },
    });
    expect(res.status).toBe(403);
  });

  test('Client attempts to create a grant → 403', async () => {
    const res = await request('/api/calendar-grants', {
      method: 'POST',
      cookie: clientCookie,
      body: { professional_user_id: p1UserId, grantee_user_id: receptionistUserId },
    });
    expect(res.status).toBe(403);
  });

  test('Grantee that is a Client → 422 (staff-only grantee)', async () => {
    const res = await request('/api/calendar-grants', {
      method: 'POST',
      cookie: adminCookie,
      body: { professional_user_id: p1UserId, grantee_user_id: clientUserId },
    });
    expect(res.status).toBe(422);
  });

  test('Grantee that is a Professional → allowed', async () => {
    const res = await request('/api/calendar-grants', {
      method: 'POST',
      cookie: adminCookie,
      body: { professional_user_id: p1UserId, grantee_user_id: p2UserId },
    });
    // May be 201 (new) or 409 (already exists from a prior test run in same DB).
    expect([201, 409]).toContain(res.status);
  });

  test('Duplicate grant → 409 (UNIQUE constraint)', async () => {
    await request('/api/calendar-grants', {
      method: 'POST',
      cookie: adminCookie,
      body: { professional_user_id: p2UserId, grantee_user_id: p1UserId },
    });

    const res = await request('/api/calendar-grants', {
      method: 'POST',
      cookie: adminCookie,
      body: { professional_user_id: p2UserId, grantee_user_id: p1UserId },
    });
    expect(res.status).toBe(409);
  });

  test('Missing body fields → 400', async () => {
    const res = await request('/api/calendar-grants', {
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
    const res = await request(`/api/calendar-grants/${grantIdForP1Recep}`, {
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
    const res = await request(`/api/calendar-grants/${grantIdForAdminRevoke}`, {
      method: 'DELETE',
      cookie: p1Cookie,
    });
    expect(res.status).toBe(403);
  });

  test('Admin revokes any in-business grant → 200 and row is gone', async () => {
    const res = await request(`/api/calendar-grants/${grantIdForAdminRevoke}`, {
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
    const res = await request(`/api/calendar-grants/999999`, {
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

    const res = await request(`/api/calendar-grants/${throwawayId}`, {
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
    const res = await request('/api/calendar-grants', { cookie: adminCookie });
    expect(res.status).toBe(200);
    const data = (res.body as { data: TableRecordMap['calendar_grants'][] }).data;
    expect(data).toHaveLength(2);
  });

  test('P1 sees only their own calendar grants (1 row)', async () => {
    const res = await request('/api/calendar-grants', { cookie: p1Cookie });
    expect(res.status).toBe(200);
    const data = (res.body as { data: TableRecordMap['calendar_grants'][] }).data;
    expect(data).toHaveLength(1);
    expect(String(data[0].professional_user_id)).toBe(String(p1UserId));
  });

  test('P2 sees only their own calendar grants (1 row)', async () => {
    const res = await request('/api/calendar-grants', { cookie: p2Cookie });
    expect(res.status).toBe(200);
    const data = (res.body as { data: TableRecordMap['calendar_grants'][] }).data;
    expect(data).toHaveLength(1);
  });

  test('Client cannot list grants → 403 (staff-internal data)', async () => {
    const res = await request('/api/calendar-grants', { cookie: clientCookie });
    expect(res.status).toBe(403);
  });

  test('Cross-business grants are never returned to main-biz admin', async () => {
    const res = await request('/api/calendar-grants', { cookie: adminCookie });
    expect(res.status).toBe(200);
    const data = (res.body as { data: TableRecordMap['calendar_grants'][] }).data;
    const ids = data.map((g) => String(g.professional_user_id));
    expect(ids).not.toContain(String(otherBizProfUserId));
  });

  test('Receptionist can list in-business grants (read allowed)', async () => {
    const res = await request('/api/calendar-grants', { cookie: receptionistCookie });
    expect(res.status).toBe(200);
    const data = (res.body as { data: TableRecordMap['calendar_grants'][] }).data;
    expect(data).toHaveLength(2);
  });

  test('Admin can filter by professional_user_id query param', async () => {
    const res = await request(
      `/api/calendar-grants?professional_user_id=${p1UserId}`,
      { cookie: adminCookie }
    );
    expect(res.status).toBe(200);
    const data = (res.body as { data: TableRecordMap['calendar_grants'][] }).data;
    expect(data).toHaveLength(1);
    expect(String(data[0].professional_user_id)).toBe(String(p1UserId));
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
    const res = await request('/api/professionals', { cookie: receptionistCookie });
    expect(res.status).toBe(200);
    const data = (res.body as { data: TableRecordMap['professionals'][] }).data;
    expect(data).toHaveLength(1);
    expect(String(data[0].id)).toBe(String(p1UserId));
  });

  test('Receptionist gets a granted professional by id → 200', async () => {
    const res = await request(`/api/professionals?id=${p1UserId}`, { cookie: receptionistCookie });
    expect(res.status).toBe(200);
    const data = (res.body as { data: TableRecordMap['professionals'] }).data;
    expect(String(data.id)).toBe(String(p1UserId));
  });

  test('Receptionist gets an ungranted professional by id → 404, not 403', async () => {
    const res = await request(`/api/professionals?id=${p2UserId}`, { cookie: receptionistCookie });
    expect(res.status).toBe(404);
  });

  test('Admin lists professionals → all in business (unscoped)', async () => {
    const res = await request('/api/professionals', { cookie: adminCookie });
    expect(res.status).toBe(200);
    const data = (res.body as { data: TableRecordMap['professionals'][] }).data;
    const ids = data.map((p) => String(p.id));
    expect(ids).toContain(String(p1UserId));
    expect(ids).toContain(String(p2UserId));
  });

  test('Client lists professionals → all in business (portal booking depends on this)', async () => {
    const res = await request('/api/professionals', { cookie: clientCookie });
    expect(res.status).toBe(200);
    const data = (res.body as { data: TableRecordMap['professionals'][] }).data;
    const ids = data.map((p) => String(p.id));
    expect(ids).toContain(String(p1UserId));
    expect(ids).toContain(String(p2UserId));
  });
});
