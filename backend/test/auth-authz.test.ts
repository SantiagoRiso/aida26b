import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { assertCrudAllowed, buildBusinessScope } from '../src/routes/crud-policy';
import type { AuthUser } from '../src/auth';
import { createApp } from '../src/app';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { Pool } from 'pg';

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 1,
    username: 'test',
    email: null,
    role: 'Admin',
    business_id: 42,
    is_active: true,
    must_change_password: false,
    ...overrides,
  };
}

const adminUser     = makeUser({ role: 'Admin',         business_id: 42 });
const receptionUser = makeUser({ role: 'Receptionist',  business_id: 42, id: 2 });
const proUser       = makeUser({ role: 'Professional',  business_id: 42, id: 3 });
const clientUser    = makeUser({ role: 'Client',        business_id: 42, id: 4 });
const otherClient   = makeUser({ role: 'Client',        business_id: 99, id: 5 });
const superAdmin    = makeUser({ role: 'Admin',         business_id: null });

describe('role gate', () => {
  test('Client cannot create clients via generic CRUD → 405', () => {
    const result = assertCrudAllowed('clients', 'create', clientUser);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(405);
      expect(result.code).toBe('operation_not_allowed');
    }
  });

  test('Receptionist can read clients → ok', () => {
    const result = assertCrudAllowed('clients', 'read', receptionUser);
    expect(result.ok).toBe(true);
  });

  test('Admin cannot create clients via generic CRUD → 405 (use admin endpoint instead)', () => {
    const result = assertCrudAllowed('clients', 'create', adminUser);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(405);
      expect(result.code).toBe('operation_not_allowed');
    }
  });

  test('Professional cannot create clients via generic CRUD → 405', () => {
    const result = assertCrudAllowed('clients', 'create', proUser);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(405);
  });
});

describe('business scope fragments', () => {
  test('businessScoped table produces a business_id = ? fragment', () => {
    const { businessWhere, businessParams } = buildBusinessScope('services', adminUser);
    expect(businessWhere).toContain('business_id');
    expect(businessParams).toEqual([42]);
  });

  test('clients (businessScoped on auth.users) produces a direct business_id fragment', () => {
    const { businessWhere, businessParams } = buildBusinessScope('clients', adminUser);
    expect(businessWhere).toContain('business_id');
    expect(businessParams).toEqual([42]);
  });

  test('Admin with null business_id gets empty fragment (sees all rows)', () => {
    const { businessWhere, businessParams } = buildBusinessScope('clients', superAdmin);
    expect(businessWhere).toBe('');
    expect(businessParams).toHaveLength(0);
  });

  test('assertCrudAllowed returns businessWhere for Receptionist reading clients', () => {
    const result = assertCrudAllowed('clients', 'read', receptionUser);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.businessWhere).not.toBe('');
      expect(result.businessParams).toEqual([42]);
    }
  });
});

describe('dual-path business scope for schedules', () => {
  test('schedules businessWhere is a two-path OR', () => {
    const result = assertCrudAllowed('schedules', 'read', adminUser);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.businessWhere).toContain('auth.users');
      expect(result.businessWhere).toContain('resources');
      expect(result.businessWhere).toContain('OR');
      expect(result.businessParams).toEqual([42, 42]);
    }
  });
});

describe('Client-only ownership', () => {
  test('Client reading clients gets ownerWhere on id', () => {
    const result = assertCrudAllowed('clients', 'read', clientUser);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ownerWhere).toBeDefined();
      expect(result.ownerWhere).toContain('"id"');
      expect(result.ownerParams).toEqual([4]);
    }
  });

  test('Receptionist reading clients gets no ownerWhere', () => {
    const result = assertCrudAllowed('clients', 'read', receptionUser);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ownerWhere).toBeUndefined();
    }
  });

  test('Admin reading clients gets no ownerWhere', () => {
    const result = assertCrudAllowed('clients', 'read', adminUser);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ownerWhere).toBeUndefined();
    }
  });
});

describe('Professional self-scope on writes', () => {
  test('Professional updating professionals is owner-scoped to their own row', () => {
    const result = assertCrudAllowed('professionals', 'update', proUser);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ownerWhere).toContain('"id"');
      expect(result.ownerParams).toEqual([3]);
    }
  });

  test('Professional reading professionals is NOT owner-scoped (can see peers)', () => {
    const result = assertCrudAllowed('professionals', 'read', proUser);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ownerWhere).toBeUndefined();
    }
  });

  test('Admin updating professionals is NOT owner-scoped (may edit any peer)', () => {
    const result = assertCrudAllowed('professionals', 'update', adminUser);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ownerWhere).toBeUndefined();
    }
  });

  test('Receptionist updating professionals is NOT owner-scoped (may edit any peer)', () => {
    const result = assertCrudAllowed('professionals', 'update', receptionUser);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ownerWhere).toBeUndefined();
    }
  });
});

const TESTS_PORT = 4139;
const API_BASE = `http://localhost:${TESTS_PORT}/api`;

let server: any;
let testsPool: Pool;
let bizA: string;
let bizB: string;
let clientUserIdA: string;
let clientUserIdB: string;

async function api(path: string, init?: RequestInit) {
  const response = await fetch(`${API_BASE}${path}`, init);
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

beforeAll(async () => {
  await resetTestDb();
  testsPool = makeTestPool();
  await runMigrations(testsPool, DEFAULT_MIGRATIONS_DIR);

  const a = await testsPool.query<{ id: string }>(
    `INSERT INTO businesses (name) VALUES ('Biz A') RETURNING id`
  );
  bizA = a.rows[0].id;

  const b = await testsPool.query<{ id: string }>(
    `INSERT INTO businesses (name) VALUES ('Biz B') RETURNING id`
  );
  bizB = b.rows[0].id;

  const uA = await testsPool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id)
     VALUES ('client_a', 'ca@test.com', 'Client A', 'h', 's', 'Client', $1) RETURNING id`,
    [bizA]
  );
  clientUserIdA = uA.rows[0].id;

  const uB = await testsPool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id)
     VALUES ('client_b', 'cb@test.com', 'Client B', 'h', 's', 'Client', $1) RETURNING id`,
    [bizB]
  );
  clientUserIdB = uB.rows[0].id;

  const app = createApp(testsPool, { defaultUser: superAdmin });
  server = app.listen(TESTS_PORT);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
});

afterAll(async () => {
  await testsPool.end();
  server.close();
});

describe('422 rejection of server-derived fields', () => {
  test('POST /services with business_id in body returns 422', async () => {
    const res = await api('/services', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_id: bizA,
        name: 'Should Fail',
        default_duration_minutes: 30,
        default_price_ars: '100.00',
      }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('server_derived_field');
    expect(res.body.error.fields?.business_id).toBeDefined();
  });
});

describe('generic routes fail closed without an authenticated user', () => {
  const PORT = 4140;
  const BASE = `http://localhost:${PORT}/api`;
  let closedServer: any;

  beforeAll(async () => {
    const app = createApp(testsPool); // no defaultUser, no session middleware
    closedServer = app.listen(PORT);
    await new Promise<void>((resolve, reject) => {
      closedServer.once('listening', resolve);
      closedServer.once('error', reject);
    });
  });

  afterAll(() => {
    closedServer.close();
  });

  async function call(path: string, init?: RequestInit) {
    const response = await fetch(`${BASE}${path}`, init);
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  }

  test('GET is rejected with 401', async () => {
    const res = await call('/clients');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  test('POST is rejected with 401', async () => {
    const res = await call('/services', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  test('PUT is rejected with 401', async () => {
    const res = await call('/services', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 1 }),
    });
    expect(res.status).toBe(401);
  });

  test('DELETE is rejected with 401', async () => {
    const res = await call('/services?id=1', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });
});

describe('cross-business visibility for a super-admin (business_id null sees all)', () => {
  test('list returns both clients for a null-business admin', async () => {
    const res = await api('/clients');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);
  });

  test('fetch client B by id succeeds for a null-business admin (no cross-business restriction)', async () => {
    const res = await api(`/clients?id=${clientUserIdB}`);
    expect(res.status).toBe(200);
    expect(String(res.body.data.id)).toBe(clientUserIdB);
  });
});
