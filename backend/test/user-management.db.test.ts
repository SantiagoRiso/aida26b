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

  const setCookie = response.headers.get('set-cookie');
  const text = await response.text();
  let responseBody: Envelope | null = null;
  try {
    responseBody = text ? (JSON.parse(text) as Envelope) : null;
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

    const body = res.body?.data as { id: string; username: string; role: string };
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
    const userId = (res.body.data as { id: number }).id;

    const userRow = await testPool.query(
      `SELECT id, display_name, role FROM auth.users WHERE id = $1`,
      [userId]
    );
    expect(userRow.rows).toHaveLength(1);
    expect(String(userRow.rows[0].id)).toBe(String(userId));
    expect(userRow.rows[0].display_name).toBe('Profile Client');
    expect(userRow.rows[0].role).toBe('Client');
  });

  test('persists optional dni on the created user', async () => {
    const res = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'dniclient1', password: 'clientpass9', role: 'Client', dni: '99887766' },
    });
    expect(res.status).toBe(201);

    const row = await testPool.query<{ dni: string }>(
      `SELECT dni FROM auth.users WHERE id = $1`,
      [(res.body.data as { id: number }).id]
    );
    expect(row.rows[0].dni).toBe('99887766');
  });
});

describe('client creation by non-admin staff', () => {
  let proCookie: string;
  let recCookie: string;
  let clientCookie: string;

  beforeAll(async () => {
    const { passwordHash, passwordSalt } = await hashPassword('staffpass1');
    await testPool.query(
      `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
       VALUES
         ('authzpro1', 'authzpro1@test.com', 'Authz Pro', $1, $2, 'Professional', $3, false),
         ('authzrec1', 'authzrec1@test.com', 'Authz Rec', $1, $2, 'Receptionist', $3, false),
         ('authzcli1', 'authzcli1@test.com', 'Authz Cli', $1, $2, 'Client', $3, false)`,
      [passwordHash, passwordSalt, adminBusinessId]
    );
    proCookie = await login('authzpro1', 'staffpass1');
    recCookie = await login('authzrec1', 'staffpass1');
    clientCookie = await login('authzcli1', 'staffpass1');
  });

  test('professional creates a Client (201) stamped with their own business', async () => {
    const res = await request('/api/admin/users', {
      method: 'POST',
      cookie: proCookie,
      body: { username: 'probooked1', password: 'clientpass1', role: 'Client' },
    });
    expect(res.status).toBe(201);

    const row = await testPool.query<{ role: string; business_id: string }>(
      `SELECT role, business_id FROM auth.users WHERE id = $1`,
      [(res.body.data as { id: number }).id]
    );
    expect(row.rows[0].role).toBe('Client');
    expect(String(row.rows[0].business_id)).toBe(adminBusinessId);
  });

  test('receptionist creates a Client (201)', async () => {
    const res = await request('/api/admin/users', {
      method: 'POST',
      cookie: recCookie,
      body: { username: 'recbooked1', password: 'clientpass1', role: 'Client' },
    });
    expect(res.status).toBe(201);

    const row = await testPool.query<{ role: string }>(
      `SELECT role FROM auth.users WHERE id = $1`,
      [(res.body.data as { id: number }).id]
    );
    expect(row.rows[0].role).toBe('Client');
  });

  test('professional requesting a Professional or Admin gets 403 and no row is created', async () => {
    for (const role of ['Professional', 'Admin']) {
      const res = await request('/api/admin/users', {
        method: 'POST',
        cookie: proCookie,
        body: { username: `escalate_${role}`, password: 'clientpass1', role },
      });
      expect(res.status, `role ${role}`).toBe(403);
    }

    const rows = await testPool.query(
      `SELECT 1 FROM auth.users WHERE username LIKE 'escalate_%'`
    );
    expect(rows.rows).toHaveLength(0);
  });

  test('client caller gets 403 even when requesting role Client', async () => {
    const res = await request('/api/admin/users', {
      method: 'POST',
      cookie: clientCookie,
      body: { username: 'selfmade1', password: 'clientpass1', role: 'Client' },
    });
    expect(res.status).toBe(403);
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
    const userId = (res.body.data as { id: number }).id;

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
    const userId = (res.body.data as { id: number }).id;

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
    const userId = (res.body.data as { id: number }).id;

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
    const userId = (res.body.data as { id: number }).id;

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
    const userId = (createRes.body.data as { id: number }).id;

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
    const userId = (createRes.body.data as { id: number }).id;

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
    const userId = (createRes.body.data as { id: number }).id;

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

  test('rejects a new password identical to the current one (400)', async () => {
    const createRes = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'reuse1', password: 'reusepass1', role: 'Receptionist' },
    });
    expect(createRes.status).toBe(201);
    const userId = (createRes.body.data as { id: number }).id;

    await testPool.query(
      `UPDATE auth.users SET must_change_password = false WHERE id = $1`,
      [userId]
    );
    const cookie = await login('reuse1', 'reusepass1');

    const res = await request('/api/auth/change-password', {
      method: 'POST',
      cookie,
      body: { current_password: 'reusepass1', new_password: 'reusepass1' },
    });
    expect(res.status).toBe(400);

    // The original password must remain valid — a no-op change is rejected, not applied.
    const stillValid = await request('/api/auth/login', {
      method: 'POST',
      body: { username: 'reuse1', password: 'reusepass1' },
    });
    expect(stillValid.status).toBe(200);
  });
});

describe('self-protection', () => {
  test('admin cannot deactivate their own account (400) and stays active', async () => {
    const idRow = await testPool.query<{ id: string }>(
      `SELECT id FROM auth.users WHERE username = 'testadmin'`
    );
    const adminId = idRow.rows[0].id;

    const res = await request(`/api/admin/users/${adminId}/deactivate`, {
      method: 'POST',
      cookie: adminCookie,
    });
    expect(res.status).toBe(400);

    const row = await testPool.query<{ is_active: boolean }>(
      `SELECT is_active FROM auth.users WHERE id = $1`,
      [adminId]
    );
    expect(row.rows[0].is_active).toBe(true);
  });

  test('admin cannot reset their own password (400); original password still works', async () => {
    const idRow = await testPool.query<{ id: string }>(
      `SELECT id FROM auth.users WHERE username = 'testadmin'`
    );
    const adminId = idRow.rows[0].id;

    const res = await request(`/api/admin/users/${adminId}/reset-password`, {
      method: 'POST',
      cookie: adminCookie,
      body: { password: 'whatever12' },
    });
    expect(res.status).toBe(400);

    const stillValid = await request('/api/auth/login', {
      method: 'POST',
      body: { username: 'testadmin', password: 'adminpass1' },
    });
    expect(stillValid.status).toBe(200);
  });
});

describe('contact-only clients', () => {
  test('creates a client with no username/password; row has null credentials', async () => {
    const res = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { role: 'Client', display_name: 'Walk In Client', email: 'walkin1@test.com' },
    });
    expect(res.status).toBe(201);

    const body = res.body?.data as { id: string; role: string };
    expect(body.role).toBe('Client');

    const row = await testPool.query<{
      username: string | null;
      password_hash: string | null;
      password_salt: string | null;
      display_name: string;
      email: string;
      role: string;
      business_id: string;
    }>(
      `SELECT username, password_hash, password_salt, display_name, email, role, business_id FROM auth.users WHERE id = $1`,
      [body.id]
    );
    expect(row.rows[0].username).toBeNull();
    expect(row.rows[0].password_hash).toBeNull();
    expect(row.rows[0].password_salt).toBeNull();
    expect(row.rows[0].display_name).toBe('Walk In Client');
    expect(row.rows[0].email).toBe('walkin1@test.com');
    expect(row.rows[0].role).toBe('Client');
    expect(String(row.rows[0].business_id)).toBe(adminBusinessId);
  });

  test('requires display_name, and rejects a malformed email when one is supplied', async () => {
    const noDisplayName = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { role: 'Client', email: 'nodisplay@test.com' },
    });
    expect(noDisplayName.status).toBe(400);

    const badEmail = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { role: 'Client', display_name: 'Bad Email Client', email: 'not-an-email' },
    });
    expect(badEmail.status).toBe(400);
  });

  test('a contact-only client cannot be logged into and is indistinguishable from unknown (401 invalid_credentials)', async () => {
    const res = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { role: 'Client', display_name: 'No Login Client', email: 'nologin1@test.com' },
    });
    expect(res.status).toBe(201);

    // No username was ever assigned, so any guess is a login attempt against an unknown account.
    const attempt = await request('/api/auth/login', {
      method: 'POST',
      body: { username: 'nologin1@test.com', password: 'whatever12' },
    });
    expect(attempt.status).toBe(401);
    expect(attempt.body?.error?.code).toBe('invalid_credentials');

    const unknownAttempt = await request('/api/auth/login', {
      method: 'POST',
      body: { username: 'definitely-does-not-exist', password: 'whatever12' },
    });
    expect(unknownAttempt.status).toBe(401);
    expect(unknownAttempt.body?.error?.code).toBe('invalid_credentials');
  });

  test('enable-login activates a contact-only client; row gets username+hash+must_change_password, and login then succeeds', async () => {
    const createRes = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { role: 'Client', display_name: 'Activate Me', email: 'activateme1@test.com' },
    });
    expect(createRes.status).toBe(201);
    const clientId = (createRes.body.data as { id: number }).id;

    const enableRes = await request(`/api/admin/users/${clientId}/enable-login`, {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'activateme1', password: 'activatepass1' },
    });
    expect(enableRes.status).toBe(200);

    const row = await testPool.query<{
      username: string;
      password_hash: string;
      password_salt: string;
      must_change_password: boolean;
    }>(
      `SELECT username, password_hash, password_salt, must_change_password FROM auth.users WHERE id = $1`,
      [clientId]
    );
    expect(row.rows[0].username).toBe('activateme1');
    expect(row.rows[0].password_hash).toBeTruthy();
    expect(row.rows[0].password_salt).toBeTruthy();
    expect(row.rows[0].must_change_password).toBe(true);

    const loginRes = await request('/api/auth/login', {
      method: 'POST',
      body: { username: 'activateme1', password: 'activatepass1' },
    });
    expect(loginRes.status).toBe(200);
  });

  test('duplicate username on activation returns 409', async () => {
    const createRes = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { role: 'Client', display_name: 'Dup Target', email: 'duptarget1@test.com' },
    });
    expect(createRes.status).toBe(201);
    const clientId = (createRes.body.data as { id: number }).id;

    // 'testadmin' already exists (seeded in beforeAll) — activation must collide on it.
    const enableRes = await request(`/api/admin/users/${clientId}/enable-login`, {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'testadmin', password: 'attemptpass1' },
    });
    expect(enableRes.status).toBe(409);
  });

  test('enable-login on an unknown/foreign/already-active user returns 404', async () => {
    const res = await request('/api/admin/users/999999/enable-login', {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'ghostuser1', password: 'ghostpass12' },
    });
    expect(res.status).toBe(404);
  });
});

describe('optional client email', () => {
  async function emailOf(userId: string | number) {
    const row = await testPool.query<{ email: string | null; role: string }>(
      `SELECT email, role FROM auth.users WHERE id = $1`,
      [userId]
    );
    return row.rows[0];
  }

  test('creates a contact-only client with no email at all', async () => {
    const res = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { role: 'Client', display_name: 'Sin Email' },
    });
    expect(res.status).toBe(201);

    const row = await emailOf((res.body.data as { id: number }).id);
    expect(row.email).toBeNull();
    expect(row.role).toBe('Client');
  });

  test('creates a client with login credentials but no email', async () => {
    const res = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'noemailclient1', password: 'clientpass1', role: 'Client' },
    });
    expect(res.status).toBe(201);

    const row = await emailOf((res.body.data as { id: number }).id);
    expect(row.email).toBeNull();
  });

  test('several clients without an email coexist — the email UNIQUE treats NULLs as distinct', async () => {
    for (const displayName of ['Anon Uno', 'Anon Dos', 'Anon Tres']) {
      const res = await request('/api/admin/users', {
        method: 'POST',
        cookie: adminCookie,
        body: { role: 'Client', display_name: displayName },
      });
      expect(res.status, displayName).toBe(201);
    }

    const count = await testPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM auth.users WHERE role = 'Client' AND email IS NULL`
    );
    expect(Number(count.rows[0].n)).toBeGreaterThanOrEqual(3);
  });

  test('a supplied email is still unique across users', async () => {
    const first = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { role: 'Client', display_name: 'Email Owner', email: 'uniqueclient1@test.com' },
    });
    expect(first.status).toBe(201);

    const duplicate = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { role: 'Client', display_name: 'Email Copycat', email: 'uniqueclient1@test.com' },
    });
    expect(duplicate.status).toBe(409);
  });

  test('staff roles still require an email — the CHECK constraint rejects a null one', async () => {
    const { passwordHash, passwordSalt } = await hashPassword('staffpass1');
    for (const role of ['Admin', 'Professional', 'Receptionist']) {
      await expect(
        testPool.query(
          `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id)
           VALUES ($1, NULL, 'No Email Staff', $2, $3, $4, $5)`,
          [`noemailstaff_${role}`, passwordHash, passwordSalt, role, adminBusinessId]
        ),
        role
      ).rejects.toThrow(/users_client_or_email/);
    }
  });

  test('enabling login on an email-less client requires an email, and stores the one supplied', async () => {
    const createRes = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { role: 'Client', display_name: 'Walkin Login' },
    });
    expect(createRes.status).toBe(201);
    const clientId = (createRes.body.data as { id: number }).id;

    const missingEmail = await request(`/api/admin/users/${clientId}/enable-login`, {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'walkinlogin1', password: 'walkinpass1' },
    });
    expect(missingEmail.status).toBe(400);

    const before = await testPool.query<{ username: string | null }>(
      `SELECT username FROM auth.users WHERE id = $1`,
      [clientId]
    );
    expect(before.rows[0].username).toBeNull();

    const enabled = await request(`/api/admin/users/${clientId}/enable-login`, {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'walkinlogin1', password: 'walkinpass1', email: 'walkinlogin1@test.com' },
    });
    expect(enabled.status).toBe(200);
    expect((await emailOf(clientId)).email).toBe('walkinlogin1@test.com');
  });

  test('enabling login never replaces the email a client already has', async () => {
    const createRes = await request('/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { role: 'Client', display_name: 'Keeps Email', email: 'keepsemail1@test.com' },
    });
    expect(createRes.status).toBe(201);
    const clientId = (createRes.body.data as { id: number }).id;

    const enabled = await request(`/api/admin/users/${clientId}/enable-login`, {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'keepsemail1', password: 'keepspass1', email: 'someoneelse1@test.com' },
    });
    expect(enabled.status).toBe(200);
    expect((await emailOf(clientId)).email).toBe('keepsemail1@test.com');
  });

  test('a client row may carry a null email at the database level', async () => {
    const inserted = await testPool.query<{ id: string }>(
      `INSERT INTO auth.users (email, display_name, role, business_id)
       VALUES (NULL, 'Direct Null Email', 'Client', $1) RETURNING id`,
      [adminBusinessId]
    );
    expect(await emailOf(inserted.rows[0].id)).toEqual({ email: null, role: 'Client' });
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
    const userId = (createRes.body.data as { id: number }).id;

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
