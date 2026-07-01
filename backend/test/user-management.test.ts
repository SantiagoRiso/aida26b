import http from 'node:http';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { app, pool } from '../src/server';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { hashPassword } from '../src/auth';
import type { Pool } from 'pg';

let testPool: Pool;

function installTestProxy() {
  pool.query = (...args: Parameters<typeof pool.query>) =>
    // @ts-expect-error — overloaded signature; delegation is safe
    testPool.query(...args);

  pool.connect = () => testPool.connect() as unknown as ReturnType<typeof pool.connect>;
}

let server: http.Server;
let baseUrl: string;

async function request(
  path: string,
  {
    method = 'GET',
    body,
    cookie,
  }: { method?: string; body?: unknown; cookie?: string } = {}
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const setCookie = response.headers.get('set-cookie');
  const text = await response.text();
  let responseBody: Record<string, unknown> | null = null;
  try {
    responseBody = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    responseBody = null;
  }

  return {
    status: response.status,
    cookie: setCookie ? setCookie.split(';')[0] : null,
    body: responseBody,
  };
}

async function login(username: string, password: string) {
  const res = await request('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  expect(res.status, `login ${username}`).toBe(200);
  expect(res.cookie).toBeTruthy();
  return res.cookie!;
}

let adminCookie: string;
let adminBusinessId: string;
let otherBusinessId: string;

beforeAll(async () => {
  await resetTestDb();
  testPool = makeTestPool();
  installTestProxy();

  await runMigrations(testPool, DEFAULT_MIGRATIONS_DIR);

  const bizRow = await testPool.query<{ id: string }>(
    `INSERT INTO businesses (name) VALUES ('Test Biz') RETURNING id`
  );
  adminBusinessId = bizRow.rows[0].id;

  const otherBiz = await testPool.query<{ id: string }>(
    `INSERT INTO businesses (name) VALUES ('Other Biz') RETURNING id`
  );
  otherBusinessId = otherBiz.rows[0].id;

  const { passwordHash, passwordSalt } = await hashPassword('adminpass1');
  await testPool.query(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ('testadmin', 'admin@test.com', 'Test Admin', $1, $2, 'Admin', $3, false)`,
    [passwordHash, passwordSalt, adminBusinessId]
  );

  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;

  adminCookie = await login('testadmin', 'adminpass1');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(resolve));
  await testPool.end();
});

describe('Client user creation', () => {
  test('creates auth.users row with Client role, must_change_password=true, and correct business_id', async () => {
    const res = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'newclient1', password: 'clientpass1', role: 'Client', display_name: 'New Client' },
    });
    expect(res.status).toBe(201);

    const body = res.body as { id: unknown; username: string; role: string };
    expect(body.role).toBe('Client');
    expect(Number(body.id)).toBeGreaterThan(0);

    const row = await testPool.query(
      `SELECT role, must_change_password, business_id FROM auth.users WHERE id = $1`,
      [body.id]
    );
    expect(row.rows[0].role).toBe('Client');
    expect(row.rows[0].must_change_password).toBe(true);
    expect(String(row.rows[0].business_id)).toBe(adminBusinessId);
  });

  test('client auth.users row has correct display_name (no separate profile table)', async () => {
    const res = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'newclient2', password: 'clientpass2', role: 'Client', display_name: 'Profile Client' },
    });
    expect(res.status).toBe(201);
    const userId = (res.body as { id: number }).id;

    const userRow = await testPool.query(
      `SELECT id, display_name, role FROM auth.users WHERE id = $1`,
      [userId]
    );
    expect(userRow.rows).toHaveLength(1);
    expect(String(userRow.rows[0].id)).toBe(String(userId));
    expect(userRow.rows[0].display_name).toBe('Profile Client');
    expect(userRow.rows[0].role).toBe('Client');
  });
});

describe('Professional user creation', () => {
  test('creates auth.users row with Professional role and display_name (no separate profile table)', async () => {
    const res = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'newpro1', password: 'propass123', role: 'Professional', display_name: 'Pro User' },
    });
    expect(res.status).toBe(201);
    const userId = (res.body as { id: number }).id;

    const userRow = await testPool.query(
      `SELECT id, display_name, role FROM auth.users WHERE id = $1`,
      [userId]
    );
    expect(userRow.rows).toHaveLength(1);
    expect(String(userRow.rows[0].id)).toBe(String(userId));
    expect(userRow.rows[0].display_name).toBe('Pro User');
    expect(userRow.rows[0].role).toBe('Professional');
  });
});

describe('Admin and Receptionist user creation', () => {
  test('Admin creation: auth.users row has Admin role, no Client/Professional role', async () => {
    const res = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'newadmin1', password: 'adminpass2', role: 'Admin' },
    });
    expect(res.status).toBe(201);
    const userId = (res.body as { id: number }).id;

    const userRow = await testPool.query(`SELECT role FROM auth.users WHERE id = $1`, [userId]);
    expect(userRow.rows).toHaveLength(1);
    expect(userRow.rows[0].role).toBe('Admin');
  });

  test('Receptionist creation: auth.users row has Receptionist role', async () => {
    const res = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'newreception1', password: 'receptionpass1', role: 'Receptionist' },
    });
    expect(res.status).toBe(201);
    const userId = (res.body as { id: number }).id;

    const userRow = await testPool.query(`SELECT role FROM auth.users WHERE id = $1`, [userId]);
    expect(userRow.rows).toHaveLength(1);
    expect(userRow.rows[0].role).toBe('Receptionist');
  });
});

describe('Rollback safety (no orphan auth.users row)', () => {
  test('duplicate username conflict leaves no orphan row and auth.users count unchanged', async () => {
    const first = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'rollbacktest', password: 'testpass1', role: 'Client' },
    });
    expect(first.status).toBe(201);

    const countBefore = await testPool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM auth.users WHERE username = 'rollbacktest'`
    );
    expect(Number(countBefore.rows[0].count)).toBe(1);

    const second = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'rollbacktest', password: 'testpass2', role: 'Client' },
    });
    expect(second.status).toBe(409);

    const countAfter = await testPool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM auth.users WHERE username = 'rollbacktest'`
    );
    expect(Number(countAfter.rows[0].count)).toBe(1);
  });
});

describe('business_id stamping', () => {
  test('body-supplied business_id is ignored; created user gets admin session business_id', async () => {
    const res = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        username: 'stamptest1',
        password: 'stamppass1',
        role: 'Admin',
        business_id: otherBusinessId,
      },
    });
    expect(res.status).toBe(201);
    const userId = (res.body as { id: number }).id;

    const row = await testPool.query<{ business_id: string }>(
      `SELECT business_id FROM auth.users WHERE id = $1`,
      [userId]
    );
    expect(String(row.rows[0].business_id)).toBe(adminBusinessId);
  });
});

describe('reset-password', () => {
  test('sets must_change_password=true and deletes the target user sessions', async () => {
    const createRes = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'resetpwuser', password: 'oldpass12', role: 'Admin' },
    });
    expect(createRes.status).toBe(201);
    const userId = (createRes.body as { id: number }).id;

    await testPool.query(
      `UPDATE auth.users SET must_change_password = false WHERE id = $1`,
      [userId]
    );
    const userCookie = await login('resetpwuser', 'oldpass12');

    const sessionsBefore = await testPool.query(
      `SELECT 1 FROM auth.sessions WHERE user_id = $1`,
      [userId]
    );
    expect(sessionsBefore.rows.length).toBeGreaterThan(0);

    const resetRes = await request(`/api/admin/users/${userId}/reset-password`, {
      method: 'POST',
      cookie: adminCookie,
      body: { password: 'newpass456' },
    });
    expect(resetRes.status).toBe(200);

    const userRow = await testPool.query<{ must_change_password: boolean }>(
      `SELECT must_change_password FROM auth.users WHERE id = $1`,
      [userId]
    );
    expect(userRow.rows[0].must_change_password).toBe(true);

    const sessionsAfter = await testPool.query(
      `SELECT 1 FROM auth.sessions WHERE user_id = $1`,
      [userId]
    );
    expect(sessionsAfter.rows.length).toBe(0);

    const meRes = await request('/api/auth/me', { cookie: userCookie });
    expect(meRes.status).toBe(401);
  });

  test('cross-business reset-password returns 404 (admin cannot reset users in another business)', async () => {
    const { passwordHash, passwordSalt } = await hashPassword('foreignpass1');
    const foreignUserRow = await testPool.query<{ id: string }>(
      `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
       VALUES ('foreignreset1', 'foreign@otherbiz.test', 'Foreign User', $1, $2, 'Admin', $3, false) RETURNING id`,
      [passwordHash, passwordSalt, otherBusinessId]
    );
    const foreignUserId = foreignUserRow.rows[0].id;

    const res = await request(`/api/admin/users/${foreignUserId}/reset-password`, {
      method: 'POST',
      cookie: adminCookie,
      body: { password: 'attacker99' },
    });
    expect(res.status).toBe(404);

    // The foreign user's password must be unchanged — the reset must not have applied.
    const stillValid = await request('/api/auth/login', {
      method: 'POST',
      body: { username: 'foreignreset1', password: 'foreignpass1' },
    });
    expect(stillValid.status).toBe(200);
  });
});

describe('deactivation', () => {
  test('deactivate sets is_active=false and removes sessions', async () => {
    const createRes = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'deactuser1', password: 'deactpass1', role: 'Admin' },
    });
    expect(createRes.status).toBe(201);
    const userId = (createRes.body as { id: number }).id;

    await testPool.query(
      `UPDATE auth.users SET must_change_password = false WHERE id = $1`,
      [userId]
    );
    const userCookie = await login('deactuser1', 'deactpass1');

    const deactRes = await request(`/api/admin/users/${userId}/deactivate`, {
      method: 'POST',
      cookie: adminCookie,
    });
    expect(deactRes.status).toBe(200);

    const row = await testPool.query<{ is_active: boolean }>(
      `SELECT is_active FROM auth.users WHERE id = $1`,
      [userId]
    );
    expect(row.rows[0].is_active).toBe(false);

    const sessions = await testPool.query(
      `SELECT 1 FROM auth.sessions WHERE user_id = $1`,
      [userId]
    );
    expect(sessions.rows.length).toBe(0);

    const badLogin = await request('/api/auth/login', {
      method: 'POST',
      body: { username: 'deactuser1', password: 'deactpass1' },
    });
    expect(badLogin.status).toBe(401);

    const meRes = await request('/api/auth/me', { cookie: userCookie });
    expect(meRes.status).toBe(401);
  });

  test('cross-business deactivate returns 404 (admin cannot deactivate users in another business)', async () => {
    const { passwordHash, passwordSalt } = await hashPassword('otherpass1');
    const otherUserRow = await testPool.query<{ id: string }>(
      `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
       VALUES ('otheruser1', 'other@otherbiz.test', 'Other User', $1, $2, 'Admin', $3, false) RETURNING id`,
      [passwordHash, passwordSalt, otherBusinessId]
    );
    const otherUserId = otherUserRow.rows[0].id;

    const res = await request(`/api/admin/users/${otherUserId}/deactivate`, {
      method: 'POST',
      cookie: adminCookie,
    });
    expect(res.status).toBe(404);
  });
});

describe('must_change_password gate', () => {
  test('a user who must change their password is blocked (403) from generic CRUD', async () => {
    const createRes = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'mustchange1', password: 'mustpass12', role: 'Receptionist' },
    });
    expect(createRes.status).toBe(201);

    // Admin-created users start with must_change_password=true; login still succeeds.
    const userCookie = await login('mustchange1', 'mustpass12');

    const res = await request('/api/clients', { cookie: userCookie });
    expect(res.status).toBe(403);
  });
});

describe('change-password session invalidation', () => {
  test('changing the password drops other sessions but keeps the current one', async () => {
    const createRes = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'sessrotate1', password: 'oldpass12', role: 'Receptionist' },
    });
    expect(createRes.status).toBe(201);
    const userId = (createRes.body as { id: number }).id;

    await testPool.query(
      `UPDATE auth.users SET must_change_password = false WHERE id = $1`,
      [userId]
    );

    const otherCookie = await login('sessrotate1', 'oldpass12');
    const currentCookie = await login('sessrotate1', 'oldpass12');

    const change = await request('/api/auth/change-password', {
      method: 'POST',
      cookie: currentCookie,
      body: { current_password: 'oldpass12', new_password: 'newpass456' },
    });
    expect(change.status).toBe(200);

    const meCurrent = await request('/api/auth/me', { cookie: currentCookie });
    expect(meCurrent.status).toBe(200);

    const meOther = await request('/api/auth/me', { cookie: otherCookie });
    expect(meOther.status).toBe(401);
  });
});

describe('role immutability', () => {
  test('no admin route accepts a role change (PUT/PATCH to role-change path returns 404)', async () => {
    const createRes = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'roleimmute1', password: 'immpass123', role: 'Client' },
    });
    expect(createRes.status).toBe(201);
    const userId = (createRes.body as { id: number }).id;

    const patchRole = await request(`/api/admin/users/${userId}/role`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: { role: 'Admin' },
    });
    expect([404, 405]).toContain(patchRole.status);

    const row = await testPool.query<{ role: string }>(
      `SELECT role FROM auth.users WHERE id = $1`,
      [userId]
    );
    expect(row.rows[0].role).toBe('Client');
  });
});
