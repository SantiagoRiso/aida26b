import { createApp } from '../src/app';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import type { AuthUser } from '../src/auth';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

// Handlers fail closed without an authenticated user; inject a cross-business super-admin
// explicitly so the policy suite exercises the privileged path without a real session.
const superAdmin: AuthUser = {
  id: 0,
  username: 'policy-admin',
  email: null,
  role: 'Admin',
  business_id: null,
  is_active: true,
  must_change_password: false,
};

const TESTS_PORT = 4138;
const API_BASE = `http://localhost:${TESTS_PORT}/api`;

let server: any;
let testsPool: Pool;
let businessId: string;
let professionalUserId: string;
let clientUserId: string;

async function api(path: string, init?: RequestInit) {
  const response = await fetch(`${API_BASE}${path}`, init);
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

beforeAll(async () => {
  await resetTestDb();
  testsPool = makeTestPool();
  await runMigrations(testsPool, DEFAULT_MIGRATIONS_DIR);

  const business = await testsPool.query<{ id: string }>(
    `INSERT INTO businesses (name) VALUES ('Policy Test Business') RETURNING id`
  );
  businessId = business.rows[0].id;

  const professionalUser = await testsPool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id)
     VALUES ('policy_pro', 'pro@policy.test', 'Policy Pro', 'h', 's', 'Professional', $1) RETURNING id`,
    [businessId]
  );
  professionalUserId = professionalUser.rows[0].id;

  const clientUser = await testsPool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id)
     VALUES ('policy_cli', 'cli@policy.test', 'Policy Client', 'h', 's', 'Client', $1) RETURNING id`,
    [businessId]
  );
  clientUserId = clientUser.rows[0].id;

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

describe('protected entities are not reachable through generic CRUD', () => {
  const protectedEntities = [
    'appointments',
    'ledger_entries',
    'audit_events',
    'users',
    'sessions',
    'calendar_grants',
    'businesses',
  ];
  // users carves out a read-only exception (admin Usuarios screen) — excluded from the
  // blanket read-block list, covered by its own describe block below instead.
  const readBlockedEntities = protectedEntities.filter((e) => e !== 'users');

  test('reads are blocked as not_found', async () => {
    for (const entity of readBlockedEntities) {
      const res = await api(`/${entity}`);
      expect(res.status, `GET ${entity}`).toBe(404);
      expect(res.body.error.code, `GET ${entity}`).toBe('not_found');
    }
  });

  test('writes are blocked as not_found', async () => {
    for (const entity of protectedEntities) {
      const res = await api(`/${entity}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status, `POST ${entity}`).toBe(404);
      expect(res.body.error.code, `POST ${entity}`).toBe('not_found');
    }
  });
});

describe('users carves out a read-only exception for the admin Usuarios screen', () => {
  test('GET users succeeds for an Admin (super-admin fixture)', async () => {
    const res = await api('/users');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  test('writes to users still 404 as not_found (create/update/delete stay protected)', async () => {
    const post = await api('/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(post.status).toBe(404);
    expect(post.body.error.code).toBe('not_found');

    const put = await api('/users/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(put.status).toBe(404);
    expect(put.body.error.code).toBe('not_found');

    const del = await api('/users/1', { method: 'DELETE' });
    expect(del.status).toBe(404);
    expect(del.body.error.code).toBe('not_found');
  });
});

describe('unknown entities are rejected', () => {
  test('GET on an unknown entity is not_found', async () => {
    const res = await api('/widgets');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('ordinary configuration entities are allowed', () => {
  test('GET clients returns the standard list envelope', async () => {
    const res = await api('/clients');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 20 });
  });
});

describe('operations the entity does not expose are rejected (405)', () => {
  test('schedules cannot be deleted generically (no DELETE grant)', async () => {
    const res = await api('/schedules/1', { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.body.error.code).toBe('operation_not_allowed');
  });

  test('client_professional_services cannot be deleted generically', async () => {
    const res = await api('/client_professional_services/1', { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.body.error.code).toBe('operation_not_allowed');
  });
});

describe('delete semantics', () => {
  test('schedule_exceptions are hard-deleted (no soft-delete columns)', async () => {
    const created = await api('/schedule_exceptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        professional_user_id: professionalUserId,
        resource_id: null,
        exception_date: '2026-07-01',
        is_unavailable: true,
        start_time: null,
        end_time: null,
        granularity_minutes: null,
        reason: null,
      }),
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    const del = await api(`/schedule_exceptions/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);

    const stored = await testsPool.query(
      `SELECT 1 FROM schedule_exceptions WHERE id = $1`,
      [id]
    );
    expect(stored.rows.length).toBe(0);
  });
});

describe('app-layer role check on generic write path', () => {
  test('POST schedules with a Client user as professional_user_id → 422 invalid_reference_role', async () => {
    const res = await api('/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        professional_user_id: clientUserId,
        resource_id: null,
        weekly: '{}',
      }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_reference_role');
  });

  test('POST schedules with a Professional user as professional_user_id → 201', async () => {
    const res = await api('/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        professional_user_id: professionalUserId,
        resource_id: null,
        weekly: '{}',
      }),
    });
    expect([201, 409]).toContain(res.status);
  });

  test('POST schedule_exceptions with a Client user as professional_user_id → 422 invalid_reference_role', async () => {
    const res = await api('/schedule_exceptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        professional_user_id: clientUserId,
        resource_id: null,
        exception_date: '2026-08-01',
        is_unavailable: true,
        start_time: null,
        end_time: null,
        granularity_minutes: null,
        reason: null,
      }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_reference_role');
  });

  test('POST schedule_exceptions with a Professional user as professional_user_id → 201', async () => {
    const res = await api('/schedule_exceptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        professional_user_id: professionalUserId,
        resource_id: null,
        exception_date: '2026-08-02',
        is_unavailable: true,
        start_time: null,
        end_time: null,
        granularity_minutes: null,
        reason: null,
      }),
    });
    expect(res.status).toBe(201);
  });

  test('POST client_professional_services with Professional as client_user_id → 422 invalid_reference_role', async () => {
    const svcRes = await testsPool.query<{ id: string }>(
      `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
       VALUES ($1, 'Role Test Svc', 30, 0) RETURNING id`,
      [businessId]
    );
    const serviceId = svcRes.rows[0].id;

    const res = await api('/client_professional_services', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_user_id: professionalUserId,   // wrong: Professional used as Client
        professional_user_id: professionalUserId,
        service_id: serviceId,
        price_ars: '10.00',
      }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_reference_role');
  });

  test('POST client_professional_services with Client as professional_user_id → 422 invalid_reference_role', async () => {
    const svcRes = await testsPool.query<{ id: string }>(
      `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
       VALUES ($1, 'Role Test Svc 2', 30, 0) RETURNING id`,
      [businessId]
    );
    const serviceId = svcRes.rows[0].id;

    const res = await api('/client_professional_services', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_user_id: clientUserId,
        professional_user_id: clientUserId,   // wrong: Client used as Professional
        service_id: serviceId,
        price_ars: '10.00',
      }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_reference_role');
  });

  test('POST client_professional_services with correct roles → 201', async () => {
    const svcRes = await testsPool.query<{ id: string }>(
      `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
       VALUES ($1, 'Role Test Svc 3', 30, 0) RETURNING id`,
      [businessId]
    );
    const serviceId = svcRes.rows[0].id;

    const res = await api('/client_professional_services', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_user_id: clientUserId,
        professional_user_id: professionalUserId,
        service_id: serviceId,
        price_ars: '10.00',
      }),
    });
    expect(res.status).toBe(201);
  });
});
