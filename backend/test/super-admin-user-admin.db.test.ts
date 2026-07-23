import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { app, pool } from '../src/server';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool, makeAppPool } from './helpers';
import { hashPassword } from '../src/auth';
import type { AuthUser } from '../src/auth';
import { mountUserAdminRoutes } from '../src/routes/users';
import { makeApiClient, dataOf, errorOf } from './api_client';
import type { CreatedUserResult, EnabledLoginResult } from '../../shared/src/ssot/contracts/users';
import type { AuthUserResult } from '../../shared/src/ssot/contracts/auth';

// A super-admin is an Admin whose own business is null: the role that exists to act across
// tenants. These routes resolve the tenant from the target row, so the super-admin reaches a user
// in any business while a tenant Admin still sees a foreign one as absent (404, never 403).

let testPool: Pool;
let server: http.Server;
let baseUrl: string;

function installTestProxy() {
  pool.query = testPool.query.bind(testPool);
  pool.connect = testPool.connect.bind(testPool);
}

type UserResult = { user: { id: string; username: string; role: string } };

const request = makeApiClient(() => baseUrl);

const PASSWORD = 'startpass1';

async function login(username: string, password: string) {
  const res = await request<AuthUserResult>('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  expect(res.status, `login ${username}`).toBe(200);
  return res.cookie!;
}

async function seedUser(
  username: string,
  role: string,
  businessId: string | null,
): Promise<string> {
  const { passwordHash, passwordSalt } = await hashPassword(PASSWORD);
  const row = await testPool.query<{ id: string }>(
    `INSERT INTO auth.users
       (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6, $7, false)
     RETURNING id`,
    [username, `${username}@test.local`, username, passwordHash, passwordSalt, role, businessId],
  );
  return row.rows[0].id;
}

async function seedContactOnlyClient(displayName: string, businessId: string): Promise<string> {
  const row = await testPool.query<{ id: string }>(
    `INSERT INTO auth.users (email, display_name, role, business_id)
     VALUES ($1, $2, 'Client', $3) RETURNING id`,
    [`${displayName}@test.local`, displayName, businessId],
  );
  return row.rows[0].id;
}

async function businessOf(userId: string | number): Promise<string | null> {
  const row = await testPool.query<{ business_id: string | null }>(
    `SELECT business_id FROM auth.users WHERE id = $1`,
    [userId],
  );
  return row.rows[0]?.business_id ?? null;
}

async function auditBusinessFor(eventType: string, targetUserId: string | number) {
  const row = await testPool.query<{ business_id: string | null }>(
    `SELECT business_id FROM audit_events
      WHERE event_type = $1 AND (details ->> 'user_id')::bigint = $2
      ORDER BY id DESC LIMIT 1`,
    [eventType, targetUserId],
  );
  return row.rows[0];
}

async function sessionCount(userId: string | number): Promise<number> {
  const row = await testPool.query<{ n: string }>(
    `SELECT count(*) AS n FROM auth.sessions WHERE user_id = $1`,
    [userId],
  );
  return Number(row.rows[0].n);
}

let bizA: string;
let bizB: string;
let superCookie: string;
let adminACookie: string;
let superAdminId: string;
let adminAId: string;

beforeAll(async () => {
  await resetTestDb();
  testPool = makeTestPool();
  installTestProxy();
  await runMigrations(testPool, DEFAULT_MIGRATIONS_DIR);

  const a = await testPool.query<{ id: string }>(
    `INSERT INTO businesses (name) VALUES ('Tenant A') RETURNING id`,
  );
  bizA = a.rows[0].id;
  const b = await testPool.query<{ id: string }>(
    `INSERT INTO businesses (name) VALUES ('Tenant B') RETURNING id`,
  );
  bizB = b.rows[0].id;

  superAdminId = await seedUser('sa_super', 'Admin', null);
  adminAId = await seedUser('sa_admin_a', 'Admin', bizA);

  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  superCookie = await login('sa_super', PASSWORD);
  adminACookie = await login('sa_admin_a', PASSWORD);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await testPool.end();
});

describe('super-admin reset-password across tenants', () => {
  test('resets a tenant user, forces a password change, and drops their sessions', async () => {
    const userId = await seedUser('sa_reset_b', 'Professional', bizB);
    await login('sa_reset_b', PASSWORD);
    expect(await sessionCount(userId)).toBeGreaterThan(0);

    const res = await request<UserResult>(`/api/admin/users/${userId}/reset-password`, {
      method: 'POST',
      cookie: superCookie,
      body: { password: 'freshpass99' },
    });
    expect(res.status).toBe(200);

    const row = await testPool.query<{ must_change_password: boolean }>(
      `SELECT must_change_password FROM auth.users WHERE id = $1`,
      [userId],
    );
    expect(row.rows[0].must_change_password).toBe(true);
    expect(await sessionCount(userId)).toBe(0);

    const relogin = await request<AuthUserResult>('/api/auth/login', {
      method: 'POST',
      body: { username: 'sa_reset_b', password: 'freshpass99' },
    });
    expect(relogin.status).toBe(200);
  });

  test("recovers a tenant's only Admin — the case no other Admin can fix", async () => {
    const soleAdminId = await seedUser('sa_sole_admin', 'Admin', bizB);

    const res = await request<UserResult>(`/api/admin/users/${soleAdminId}/reset-password`, {
      method: 'POST',
      cookie: superCookie,
      body: { password: 'recovered99' },
    });
    expect(res.status).toBe(200);

    const relogin = await request<AuthUserResult>('/api/auth/login', {
      method: 'POST',
      body: { username: 'sa_sole_admin', password: 'recovered99' },
    });
    expect(relogin.status).toBe(200);
  });

  test('the event is filed under the tenant it affected, not under the actor', async () => {
    const userId = await seedUser('sa_reset_audit', 'Receptionist', bizB);

    const res = await request<UserResult>(`/api/admin/users/${userId}/reset-password`, {
      method: 'POST',
      cookie: superCookie,
      body: { password: 'auditpass99' },
    });
    expect(res.status).toBe(200);

    const event = await auditBusinessFor('password_reset', userId);
    expect(event).toBeDefined();
    expect(event.business_id).toBe(bizB);
  });
});

describe('super-admin deactivate across tenants', () => {
  test('archives a tenant user and drops their sessions', async () => {
    const userId = await seedUser('sa_deact_b', 'Receptionist', bizB);
    await login('sa_deact_b', PASSWORD);

    const res = await request<UserResult>(`/api/admin/users/${userId}/deactivate`, {
      method: 'POST',
      cookie: superCookie,
    });
    expect(res.status).toBe(200);

    const row = await testPool.query<{ is_active: boolean; deleted_at: string | null }>(
      `SELECT is_active, deleted_at FROM auth.users WHERE id = $1`,
      [userId],
    );
    expect(row.rows[0].is_active).toBe(false);
    expect(row.rows[0].deleted_at).not.toBeNull();
    expect(await sessionCount(userId)).toBe(0);
  });

  test('the event is filed under the target tenant', async () => {
    const userId = await seedUser('sa_deact_audit', 'Receptionist', bizB);

    const res = await request<UserResult>(`/api/admin/users/${userId}/deactivate`, {
      method: 'POST',
      cookie: superCookie,
    });
    expect(res.status).toBe(200);

    const event = await auditBusinessFor('user_deactivated', userId);
    expect(event.business_id).toBe(bizB);
  });
});

describe('super-admin enable-login across tenants', () => {
  test('activates a contact-only client in another tenant and the client can then log in', async () => {
    const clientId = await seedContactOnlyClient('sa_walkin', bizB);

    const res = await request<EnabledLoginResult>(`/api/admin/users/${clientId}/enable-login`, {
      method: 'POST',
      cookie: superCookie,
      body: { username: 'sa_walkin_login', password: 'walkinpass9' },
    });
    expect(res.status).toBe(200);

    const loginRes = await request<AuthUserResult>('/api/auth/login', {
      method: 'POST',
      body: { username: 'sa_walkin_login', password: 'walkinpass9' },
    });
    expect(loginRes.status).toBe(200);

    const event = await auditBusinessFor('login_enabled', clientId);
    expect(event.business_id).toBe(bizB);
  });
});

describe('super-admin user creation', () => {
  test('creates a user in the named tenant', async () => {
    const res = await request<CreatedUserResult>('/api/admin/users', {
      method: 'POST',
      cookie: superCookie,
      body: {
        username: 'sa_created_b',
        password: 'createdpass1',
        role: 'Admin',
        email: 'sa_created_b@test.local',
        target_business_id: Number(bizB),
      },
    });
    expect(res.status).toBe(201);
    expect(await businessOf(dataOf(res).id)).toBe(bizB);

    const event = await auditBusinessFor('user_created', dataOf(res).id);
    expect(event.business_id).toBe(bizB);
  });

  test('without a named tenant nothing is created', async () => {
    const res = await request<CreatedUserResult>('/api/admin/users', {
      method: 'POST',
      cookie: superCookie,
      body: { username: 'sa_orphan', password: 'orphanpass1', role: 'Admin', email: 'sa_orphan@test.local' },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).detail?.key).toBe('targetBusinessRequired');

    const rows = await testPool.query(`SELECT 1 FROM auth.users WHERE username = 'sa_orphan'`);
    expect(rows.rows).toHaveLength(0);
  });

  test('a nonexistent tenant is refused cleanly, not left to the foreign key', async () => {
    const res = await request<CreatedUserResult>('/api/admin/users', {
      method: 'POST',
      cookie: superCookie,
      body: {
        username: 'sa_ghost_biz',
        password: 'ghostpass1',
        role: 'Admin',
        email: 'sa_ghost_biz@test.local',
        target_business_id: 999999,
      },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).detail?.key).toBe('targetBusinessNotFound');

    const rows = await testPool.query(`SELECT 1 FROM auth.users WHERE username = 'sa_ghost_biz'`);
    expect(rows.rows).toHaveLength(0);
  });

  test('a malformed tenant is refused', async () => {
    const res = await request<CreatedUserResult>('/api/admin/users', {
      method: 'POST',
      cookie: superCookie,
      body: {
        username: 'sa_bad_biz',
        password: 'badbizpass1',
        role: 'Admin',
        email: 'sa_bad_biz@test.local',
        target_business_id: 'not-a-number',
      },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).detail?.key).toBe('targetBusinessRequired');
  });

  test('creates a contact-only client in the named tenant', async () => {
    const res = await request<CreatedUserResult>('/api/admin/users', {
      method: 'POST',
      cookie: superCookie,
      body: { role: 'Client', display_name: 'Sa Walkin Two', target_business_id: Number(bizB) },
    });
    expect(res.status).toBe(201);
    expect(await businessOf(dataOf(res).id)).toBe(bizB);
  });
});

describe('a tenant Admin is unchanged', () => {
  test('naming another tenant is refused, not honoured', async () => {
    const res = await request<CreatedUserResult>('/api/admin/users', {
      method: 'POST',
      cookie: adminACookie,
      body: {
        username: 'sa_smuggled',
        password: 'smugglepass1',
        role: 'Admin',
        email: 'sa_smuggled@test.local',
        target_business_id: Number(bizB),
      },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).detail?.key).toBe('targetBusinessNotAllowed');

    const rows = await testPool.query(`SELECT 1 FROM auth.users WHERE username = 'sa_smuggled'`);
    expect(rows.rows).toHaveLength(0);
  });

  test('their own creations are still stamped with their session business', async () => {
    const res = await request<CreatedUserResult>('/api/admin/users', {
      method: 'POST',
      cookie: adminACookie,
      body: { username: 'sa_own_a', password: 'ownpass123', role: 'Receptionist', email: 'sa_own_a@test.local' },
    });
    expect(res.status).toBe(201);
    expect(await businessOf(dataOf(res).id)).toBe(bizA);
  });

  test('a foreign target is absent for reset, deactivate and enable-login alike (404)', async () => {
    const foreignId = await seedUser('sa_foreign_b', 'Professional', bizB);
    const foreignClientId = await seedContactOnlyClient('sa_foreign_client', bizB);

    const reset = await request<UserResult>(`/api/admin/users/${foreignId}/reset-password`, {
      method: 'POST',
      cookie: adminACookie,
      body: { password: 'attacker99' },
    });
    expect(reset.status).toBe(404);

    const deactivate = await request<UserResult>(`/api/admin/users/${foreignId}/deactivate`, {
      method: 'POST',
      cookie: adminACookie,
    });
    expect(deactivate.status).toBe(404);

    const enable = await request<EnabledLoginResult>(`/api/admin/users/${foreignClientId}/enable-login`, {
      method: 'POST',
      cookie: adminACookie,
      body: { username: 'sa_foreign_login', password: 'foreignpass9' },
    });
    expect(enable.status).toBe(404);

    // None of the three may have taken effect.
    const row = await testPool.query<{ is_active: boolean; must_change_password: boolean }>(
      `SELECT is_active, must_change_password FROM auth.users WHERE id = $1`,
      [foreignId],
    );
    expect(row.rows[0]).toEqual({ is_active: true, must_change_password: false });

    const client = await testPool.query<{ username: string | null }>(
      `SELECT username FROM auth.users WHERE id = $1`,
      [foreignClientId],
    );
    expect(client.rows[0].username).toBeNull();
  });
});

describe('self-protection survives the widening', () => {
  test('a super-admin cannot reset their own password', async () => {
    const res = await request<UserResult>(`/api/admin/users/${superAdminId}/reset-password`, {
      method: 'POST',
      cookie: superCookie,
      body: { password: 'selfpass999' },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).detail?.key).toBe('cannotResetOwnPassword');

    const stillValid = await request<AuthUserResult>('/api/auth/login', {
      method: 'POST',
      body: { username: 'sa_super', password: PASSWORD },
    });
    expect(stillValid.status).toBe(200);
  });

  test('a super-admin cannot deactivate their own account', async () => {
    const res = await request<UserResult>(`/api/admin/users/${superAdminId}/deactivate`, {
      method: 'POST',
      cookie: superCookie,
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).detail?.key).toBe('cannotDeactivateSelf');

    const row = await testPool.query<{ is_active: boolean }>(
      `SELECT is_active FROM auth.users WHERE id = $1`,
      [superAdminId],
    );
    expect(row.rows[0].is_active).toBe(true);
  });

  test('a tenant Admin still cannot reset their own password', async () => {
    const res = await request<UserResult>(`/api/admin/users/${adminAId}/reset-password`, {
      method: 'POST',
      cookie: adminACookie,
      body: { password: 'selfpass999' },
    });
    expect(res.status).toBe(400);
  });
});

describe('the widening is the super-admin role, not the absent business', () => {
  test('a Client is refused by role before any scope is resolved', async () => {
    await seedUser('sa_client_a', 'Client', bizA);
    const clientCookie = await login('sa_client_a', PASSWORD);

    const res = await request<UserResult>(`/api/admin/users/${adminAId}/deactivate`, {
      method: 'POST',
      cookie: clientCookie,
    });
    expect(res.status).toBe(403);
  });

  // users_admin_or_business makes a tenantless non-Admin impossible in data, so the session is
  // injected: what is under test is that the routes fail closed on the role, not that the CHECK
  // holds. A forged or stale session must not inherit the cross-tenant reach.
  describe('a tenantless non-Admin session', () => {
    let injectedApp: express.Express;
    let injectedServer: http.Server;
    let injectedPool: Pool;
    let injectedUrl: string;
    let sessionUser: AuthUser;

    const injectedRequest = makeApiClient(() => injectedUrl);

    beforeAll(async () => {
      injectedApp = express();
      injectedApp.use(express.json());
      injectedPool = makeAppPool();
      mountUserAdminRoutes(injectedApp, injectedPool, {
        audit: async () => {},
        requireAuth: (req, _res, next) => {
          (req as express.Request & { user?: AuthUser }).user = sessionUser;
          next();
        },
        requirePasswordReady: (_req, _res, next) => next(),
        requireAdmin: (req, res, next) => {
          if ((req as express.Request & { user?: AuthUser }).user?.role === 'Admin') return next();
          res.status(403).json({ success: false, error: { code: 'forbidden', message: 'Forbidden' } });
        },
      });

      injectedServer = http.createServer(injectedApp);
      await new Promise<void>((resolve, reject) => {
        injectedServer.once('error', reject);
        injectedServer.listen(0, '127.0.0.1', resolve);
      });
      injectedUrl = `http://127.0.0.1:${(injectedServer.address() as { port: number }).port}`;

      sessionUser = {
        id: Number(adminAId),
        username: 'sa_forged_pro',
        email: null,
        role: 'Professional',
        business_id: null,
        is_active: true,
        must_change_password: false,
      };
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => injectedServer.close(() => resolve()));
      await injectedPool.end();
    });

    test('cannot create a user, with or without a named tenant', async () => {
      const create = await injectedRequest<CreatedUserResult>('/api/admin/users', {
        method: 'POST',
        body: { username: 'sa_forged_made', password: 'forgedpass1', role: 'Client', email: 'sa_forged_made@test.local' },
      });
      expect(create.status).toBe(400);
      expect(errorOf(create).code).toBe('no_business');

      const named = await injectedRequest<CreatedUserResult>('/api/admin/users', {
        method: 'POST',
        body: {
          username: 'sa_forged_made2',
          password: 'forgedpass1',
          role: 'Client',
          email: 'sa_forged_made2@test.local',
          target_business_id: Number(bizB),
        },
      });
      expect(named.status).toBe(400);
      expect(errorOf(named).detail?.key).toBe('targetBusinessNotAllowed');

      const rows = await testPool.query(`SELECT 1 FROM auth.users WHERE username LIKE 'sa_forged_made%'`);
      expect(rows.rows).toHaveLength(0);
    });

    test('cannot enable login on a client in any tenant', async () => {
      const clientId = await seedContactOnlyClient('sa_forged_target', bizB);

      const res = await injectedRequest<EnabledLoginResult>(`/api/admin/users/${clientId}/enable-login`, {
        method: 'POST',
        body: { username: 'sa_forged_login', password: 'forgedlogin1' },
      });
      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('no_business');

      const row = await testPool.query<{ username: string | null }>(
        `SELECT username FROM auth.users WHERE id = $1`,
        [clientId],
      );
      expect(row.rows[0].username).toBeNull();
    });
  });
});
