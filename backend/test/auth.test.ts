// @ts-nocheck
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'vitest';
import { app, pool } from '../src/server';
import { hashPassword } from '../src/auth';
import { isAuthUser } from '../../shared/src/ssot/contracts/auth';

class FakeDb {
  constructor(users) {
    this.users = users;
    this.sessions = [];
    this.audit = [];
    this.clients = [];
    this.professionals = [];
    this.nextUserId = Math.max(...users.map((user) => user.id)) + 1;
    this.nextClientId = 1;
  }

  async query(text, params = []) {
    const sql = text.replace(/\s+/g, ' ').trim();

    if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)) {
      return { rows: [] };
    }

    if (sql.startsWith('SELECT business_id FROM auth.users WHERE id')) {
      const user = this.users.find((item) => item.id === params[0]);
      return { rows: user ? [{ business_id: user.business_id ?? null }] : [] };
    }
    if (sql.startsWith('INSERT INTO audit_events')) {
      this.audit.push({ business_id: params[0], actor_user_id: params[1], event_type: params[2], outcome: params[5] });
      return { rows: [] };
    }
    if (sql.includes('FROM auth.users WHERE username = $1')) {
      return { rows: this.users.filter((user) => user.username === params[0]) };
    }
    if (sql.startsWith('SELECT password_hash, password_salt FROM auth.users WHERE id')) {
      const user = this.users.find((item) => item.id === params[0]);
      return { rows: user ? [{ password_hash: user.password_hash, password_salt: user.password_salt }] : [] };
    }
    if (sql.startsWith('INSERT INTO auth.sessions')) {
      this.sessions.push({ user_id: params[0], token_hash: params[1], expires_at: Date.now() + 604800000 });
      return { rows: [] };
    }
    if (sql.startsWith('SELECT s.id AS session_id')) {
      const session = this.sessions.find((item) => item.token_hash === params[0] && item.expires_at > Date.now());
      const user = session && this.users.find((item) => item.id === session.user_id && item.is_active);
      return { rows: user ? [{ session_id: 1, ...user }] : [] };
    }
    if (sql.startsWith('DELETE FROM auth.sessions WHERE token_hash')) {
      this.sessions = this.sessions.filter((item) => item.token_hash !== params[0]);
      return { rows: [] };
    }
    if (sql.startsWith('DELETE FROM auth.sessions WHERE user_id')) {
      if (sql.includes('token_hash <>')) {
        // change-password drops the user's other sessions but keeps the current token (params[1]).
        this.sessions = this.sessions.filter(
          (item) => item.user_id !== params[0] || item.token_hash === params[1],
        );
      } else {
        this.sessions = this.sessions.filter((item) => item.user_id !== params[0]);
      }
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO auth.users')) {
      if (this.users.some((user) => user.username === params[0])) {
        throw Object.assign(new Error('duplicate username'), { code: '23505' });
      }
      const user = {
        id: this.nextUserId++,
        username: params[0],
        email: params[1],
        display_name: params[2],
        dni: params[3] ?? null,
        password_hash: params[4],
        password_salt: params[5],
        role: params[6],
        business_id: params[7] ?? null,
        is_active: true,
        must_change_password: true,
      };
      this.users.push(user);
      return { rows: [{ id: user.id }] };
    }
    if (sql.startsWith('UPDATE auth.users SET password_hash')) {
      const user = this.users.find((item) => item.id === params[2]);
      if (!user) return { rows: [] };
      user.password_hash = params[0];
      user.password_salt = params[1];
      user.must_change_password = sql.includes('must_change_password = true');
      return { rows: [publicRow(user)] };
    }

    if (sql.startsWith('SELECT COUNT(') && /FROM auth\.users/i.test(sql) && /role/i.test(sql)) {
      const role = params[0];
      const bizId = params[1] !== undefined ? params[1] : null;
      const matching = this.users.filter(
        (u) => u.role === role && (bizId === null || u.business_id === bizId) && !u.deleted_at,
      );
      return { rows: [{ count: String(matching.length) }] };
    }
    if (/SELECT base\..*COUNT\(\*\) OVER\(\).*FROM \(SELECT \* FROM auth\.users/i.test(sql)) {
      const role = params[0];
      const bizId = params[1] !== undefined ? params[1] : null;
      const matching = this.users.filter(
        (u) => u.role === role && (bizId === null || u.business_id === bizId) && !u.deleted_at,
      );
      return { rows: matching.map((row) => ({ ...row, __total_count: String(matching.length) })) };
    }

    throw new Error(`Unhandled query: ${sql}`);
  }
}

function publicRow(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    business_id: user.business_id ?? null,
    is_active: user.is_active,
    must_change_password: user.must_change_password,
  };
}

async function makeDb() {
  const admin = await hashPassword('adminpass');
  const professional = await hashPassword('propass');
  const client = await hashPassword('clientpass');
  return new FakeDb([
    { id: 1, username: 'admin', email: null, role: 'Admin', business_id: 1, is_active: true, must_change_password: false, password_hash: admin.passwordHash, password_salt: admin.passwordSalt },
    { id: 2, username: 'pro', email: null, role: 'Professional', business_id: 1, is_active: true, must_change_password: false, password_hash: professional.passwordHash, password_salt: professional.passwordSalt },
    { id: 3, username: 'client', email: null, role: 'Client', business_id: 1, is_active: true, must_change_password: false, password_hash: client.passwordHash, password_salt: client.passwordSalt },
  ]);
}

async function withServer(db, run) {
  pool.query = db.query.bind(db);
  pool.connect = async () => ({
    query: db.query.bind(db),
    release: async () => {},
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function request(baseUrl, path, { method = 'GET', body, cookie } = {}) {
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
  return { status: response.status, cookie: setCookie ? setCookie.split(';')[0] : null, body: text ? JSON.parse(text) : null };
}

async function login(baseUrl, username, password) {
  const response = await request(baseUrl, '/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(response.status, 200);
  assert.ok(response.cookie.startsWith('aida_session='));
  return response.cookie;
}

test('login, me and logout manage the session cookie', async () => {
  const db = await makeDb();
  await withServer(db, async (baseUrl) => {
    const badLogin = await request(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrongpass' } });
    assert.equal(badLogin.status, 401);

    const loginRes = await request(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'adminpass' } });
    assert.equal(loginRes.status, 200);
    assert.ok(isAuthUser(loginRes.body.data.user));
    assert.equal(loginRes.body.data.user.business_id, 1);
    assert.equal(loginRes.body.data.user.must_change_password, false);
    const cookie = loginRes.cookie;
    assert.ok(cookie.startsWith('aida_session='));

    const me = await request(baseUrl, '/api/auth/me', { cookie });
    assert.equal(me.status, 200);
    assert.ok(isAuthUser(me.body.data.user));
    assert.equal(me.body.data.user.role, 'Admin');
    assert.equal(me.body.data.user.business_id, 1);
    assert.equal(me.body.data.user.must_change_password, false);

    const logout = await request(baseUrl, '/api/auth/logout', { method: 'POST', cookie });
    assert.equal(logout.status, 204);
    const afterLogout = await request(baseUrl, '/api/auth/me', { cookie });
    assert.equal(afterLogout.status, 401);
  });
});

test('non-admin can read clients but POST is disabled for all (405)', async () => {
  const db = await makeDb();
  await withServer(db, async (baseUrl) => {
    const cookie = await login(baseUrl, 'pro', 'propass');
    assert.equal((await request(baseUrl, '/api/clients', { cookie })).status, 200);
    const write = await request(baseUrl, '/api/clients', {
      method: 'POST',
      cookie,
      body: { display_name: 'Ada', phone: '1', notes: null },
    });
    assert.equal(write.status, 405);
    assert.equal(write.body.error.code, 'operation_not_allowed');
  });
});

test('generic POST to clients is disabled (405) — creation is via admin endpoint only', async () => {
  const db = await makeDb();
  await withServer(db, async (baseUrl) => {
    const cookie = await login(baseUrl, 'admin', 'adminpass');
    const created = await request(baseUrl, '/api/clients', {
      method: 'POST',
      cookie,
      body: { display_name: 'Grace Hopper', phone: '2', notes: null },
    });
    assert.equal(created.status, 405);
    assert.equal(created.body.error.code, 'operation_not_allowed');
  });
});

test('admin can create users and reset passwords', async () => {
  const db = await makeDb();
  await withServer(db, async (baseUrl) => {
    const adminCookie = await login(baseUrl, 'admin', 'adminpass');
    const created = await request(baseUrl, '/api/admin/users', { method: 'POST', cookie: adminCookie, body: { username: 'newclient', password: 'firstpass', role: 'Client', email: 'newclient@test.com' } });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.role, 'Client');

    const reset = await request(baseUrl, `/api/admin/users/${created.body.data.id}/reset-password`, { method: 'POST', cookie: adminCookie, body: { password: 'secondpass' } });
    assert.equal(reset.status, 200);

    const newCookie = await login(baseUrl, 'newclient', 'secondpass');
    const me = await request(baseUrl, '/api/auth/me', { cookie: newCookie });
    assert.equal(me.body.data.user.must_change_password, true);
  });
});

// Professionals/Receptionists may register Clients, but never staff accounts;
// Clients cannot create users at all.
test('non-admin cannot create staff users', async () => {
  const db = await makeDb();
  await withServer(db, async (baseUrl) => {
    const cookie = await login(baseUrl, 'pro', 'propass');
    const createStaff = await request(baseUrl, '/api/admin/users', { method: 'POST', cookie, body: { username: 'other', password: 'otherpass', role: 'Admin' } });
    assert.equal(createStaff.status, 403);

    const clientCookie = await login(baseUrl, 'client', 'clientpass');
    const asClient = await request(baseUrl, '/api/admin/users', { method: 'POST', cookie: clientCookie, body: { username: 'other2', password: 'otherpass', role: 'Client', email: 'other2@test.com' } });
    assert.equal(asClient.status, 403);
  });
});

test('duplicate username returns conflict', async () => {
  const db = await makeDb();
  await withServer(db, async (baseUrl) => {
    const adminCookie = await login(baseUrl, 'admin', 'adminpass');
    assert.equal((await request(baseUrl, '/api/admin/users', { method: 'POST', cookie: adminCookie, body: { username: 'dupe', password: 'firstpass', role: 'Client', email: 'dupe1@test.com' } })).status, 201);
    assert.equal((await request(baseUrl, '/api/admin/users', { method: 'POST', cookie: adminCookie, body: { username: 'dupe', password: 'firstpass', role: 'Client', email: 'dupe2@test.com' } })).status, 409);
  });
});

test('first login users must change password before using the app', async () => {
  const db = await makeDb();
  await withServer(db, async (baseUrl) => {
    const adminCookie = await login(baseUrl, 'admin', 'adminpass');
    await request(baseUrl, '/api/admin/users', { method: 'POST', cookie: adminCookie, body: { username: 'tempuser', password: 'temppass1', role: 'Client', email: 'tempuser@test.com' } });

    const tempCookie = await login(baseUrl, 'tempuser', 'temppass1');
    const blocked = await request(baseUrl, '/api/clients', { cookie: tempCookie });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.message, 'Password change required');

    const changed = await request(baseUrl, '/api/auth/change-password', {
      method: 'POST',
      cookie: tempCookie,
      body: { current_password: 'temppass1', new_password: 'newpass123' },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.data.user.must_change_password, false);
    assert.equal((await request(baseUrl, '/api/clients', { cookie: tempCookie })).status, 200);
  });
});

test('must_change_password blocks write routes and clears after change', async () => {
  const db = await makeDb();
  await withServer(db, async (baseUrl) => {
    const adminCookie = await login(baseUrl, 'admin', 'adminpass');
    await request(baseUrl, '/api/admin/users', { method: 'POST', cookie: adminCookie, body: { username: 'writetest', password: 'pass1234', role: 'Admin' } });

    const tempCookie = await login(baseUrl, 'writetest', 'pass1234');

    const blockedWrite = await request(baseUrl, '/api/services', {
      method: 'POST',
      cookie: tempCookie,
      body: { name: 'Haircut', default_duration_minutes: 30, default_price_ars: '100.00' },
    });
    assert.equal(blockedWrite.status, 403);
    assert.equal(blockedWrite.body.error.message, 'Password change required');

    const logoutRes = await request(baseUrl, '/api/auth/logout', { method: 'POST', cookie: tempCookie });
    assert.equal(logoutRes.status, 204);
  });
});

test('change-password response carries business_id', async () => {
  const db = await makeDb();
  await withServer(db, async (baseUrl) => {
    const adminCookie = await login(baseUrl, 'admin', 'adminpass');
    await request(baseUrl, '/api/admin/users', { method: 'POST', cookie: adminCookie, body: { username: 'chpwuser', password: 'oldpass1', role: 'Client', email: 'chpwuser@test.com' } });

    const tempCookie = await login(baseUrl, 'chpwuser', 'oldpass1');
    const changed = await request(baseUrl, '/api/auth/change-password', {
      method: 'POST',
      cookie: tempCookie,
      body: { current_password: 'oldpass1', new_password: 'newpass123' },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.data.user.must_change_password, false);
    assert.ok('business_id' in changed.body.data.user);
  });
});
