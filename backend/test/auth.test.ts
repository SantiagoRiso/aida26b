// @ts-nocheck
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'vitest';
import { app, pool } from '../src/server';
import { hashPassword } from '../src/auth';

class FakeDb {
  constructor(users) {
    this.users = users;
    this.sessions = [];
    this.audit = [];
    this.clients = [];
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
      this.sessions = this.sessions.filter((item) => item.user_id !== params[0]);
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
        password_hash: params[2],
        password_salt: params[3],
        role: params[4],
        business_id: null,
        is_active: true,
        must_change_password: true,
      };
      this.users.push(user);
      return { rows: [publicRow(user)] };
    }
    if (sql.startsWith('UPDATE auth.users SET password_hash')) {
      const user = this.users.find((item) => item.id === params[2]);
      if (!user) return { rows: [] };
      user.password_hash = params[0];
      user.password_salt = params[1];
      user.must_change_password = sql.includes('must_change_password = true');
      return { rows: [publicRow(user)] };
    }

    // Generic CRUD over clients exercised by the write/read guard tests.
    if (sql.startsWith('SELECT COUNT(') && /FROM clients/i.test(sql)) {
      return { rows: [{ count: this.clients.length }] };
    }
    if (/SELECT \* FROM clients/i.test(sql) || /FROM clients/i.test(sql)) {
      return { rows: this.clients };
    }
    if (sql.startsWith('INSERT INTO clients')) {
      const client = {
        id: String(this.nextClientId++),
        business_id: params[0],
        user_id: params[1],
        display_name: params[2],
        email: params[3],
        phone: params[4],
        notes: params[5],
      };
      this.clients.push(client);
      return { rows: [client] };
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

    const cookie = await login(baseUrl, 'admin', 'adminpass');
    const me = await request(baseUrl, '/api/auth/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.role, 'Admin');

    const logout = await request(baseUrl, '/api/auth/logout', { method: 'POST', cookie });
    assert.equal(logout.status, 204);
    const afterLogout = await request(baseUrl, '/api/auth/me', { cookie });
    assert.equal(afterLogout.status, 401);
  });
});

test('non-admin can read but cannot mutate scheduler data', async () => {
  const db = await makeDb();
  await withServer(db, async (baseUrl) => {
    const cookie = await login(baseUrl, 'pro', 'propass');
    assert.equal((await request(baseUrl, '/api/clients', { cookie })).status, 200);
    const write = await request(baseUrl, '/api/clients', {
      method: 'POST',
      cookie,
      body: { business_id: '1', user_id: '3', display_name: 'Ada', email: 'ada@example.com', phone: '1', notes: null },
    });
    assert.equal(write.status, 403);
    assert.equal(db.audit.at(-1).event_type, 'permission_denied');
  });
});

test('admin can create a client through generic CRUD', async () => {
  const db = await makeDb();
  await withServer(db, async (baseUrl) => {
    const cookie = await login(baseUrl, 'admin', 'adminpass');
    const created = await request(baseUrl, '/api/clients', {
      method: 'POST',
      cookie,
      body: { business_id: '1', user_id: '3', display_name: 'Grace Hopper', email: 'grace@example.com', phone: '2', notes: null },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.display_name, 'Grace Hopper');
    assert.equal(db.clients.length, 1);
  });
});

test('admin can create users and reset passwords', async () => {
  const db = await makeDb();
  await withServer(db, async (baseUrl) => {
    const adminCookie = await login(baseUrl, 'admin', 'adminpass');
    const created = await request(baseUrl, '/api/admin/users', { method: 'POST', cookie: adminCookie, body: { username: 'newclient', password: 'firstpass', role: 'Client' } });
    assert.equal(created.status, 201);
    assert.equal(created.body.role, 'Client');

    const reset = await request(baseUrl, `/api/admin/users/${created.body.id}/reset-password`, { method: 'POST', cookie: adminCookie, body: { password: 'secondpass' } });
    assert.equal(reset.status, 200);

    const newCookie = await login(baseUrl, 'newclient', 'secondpass');
    const me = await request(baseUrl, '/api/auth/me', { cookie: newCookie });
    assert.equal(me.body.user.must_change_password, true);
  });
});

test('non-admin cannot manage users', async () => {
  const db = await makeDb();
  await withServer(db, async (baseUrl) => {
    const cookie = await login(baseUrl, 'pro', 'propass');
    const createUser = await request(baseUrl, '/api/admin/users', { method: 'POST', cookie, body: { username: 'other', password: 'otherpass', role: 'Client' } });
    assert.equal(createUser.status, 403);
  });
});

test('duplicate username returns conflict', async () => {
  const db = await makeDb();
  await withServer(db, async (baseUrl) => {
    const adminCookie = await login(baseUrl, 'admin', 'adminpass');
    assert.equal((await request(baseUrl, '/api/admin/users', { method: 'POST', cookie: adminCookie, body: { username: 'dupe', password: 'firstpass', role: 'Client' } })).status, 201);
    assert.equal((await request(baseUrl, '/api/admin/users', { method: 'POST', cookie: adminCookie, body: { username: 'dupe', password: 'firstpass', role: 'Client' } })).status, 409);
  });
});

test('first login users must change password before using the app', async () => {
  const db = await makeDb();
  await withServer(db, async (baseUrl) => {
    const adminCookie = await login(baseUrl, 'admin', 'adminpass');
    await request(baseUrl, '/api/admin/users', { method: 'POST', cookie: adminCookie, body: { username: 'tempuser', password: 'temppass1', role: 'Client' } });

    const tempCookie = await login(baseUrl, 'tempuser', 'temppass1');
    const blocked = await request(baseUrl, '/api/clients', { cookie: tempCookie });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, 'Password change required');

    const changed = await request(baseUrl, '/api/auth/change-password', {
      method: 'POST',
      cookie: tempCookie,
      body: { current_password: 'temppass1', new_password: 'newpass123' },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.user.must_change_password, false);
    assert.equal((await request(baseUrl, '/api/clients', { cookie: tempCookie })).status, 200);
  });
});
