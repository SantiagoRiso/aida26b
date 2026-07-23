import http from 'node:http';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { app, pool } from '../src/server';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { hashPassword } from '../src/auth';
import { makeApiClient, dataOf, errorOf } from './api_client';
import type { AuthUserResult } from '../../shared/src/ssot/contracts/auth';

// A super-admin is an Admin whose own business is null: the cross-tenant role. The domain-write
// routes it can reach resolve the target tenant from the request — the target row for a scoped
// edit, an explicit target_business_id for a create — so it manages a tenant's closures, settings
// and grants on that tenant's behalf, while a tenant Admin still sees a foreign row as absent (404,
// never 403) and its own writes stay stamped with its session business. Every event lands under the
// affected tenant, not the actor.

let testPool: Pool;
let server: http.Server;
let baseUrl: string;

function installTestProxy() {
  pool.query = testPool.query.bind(testPool);
  pool.connect = testPool.connect.bind(testPool);
}

const request = makeApiClient(() => baseUrl);
const PASSWORD = 'startpass1';

type ClosureData = { id: string; exception_date: string; business_id?: string };
type SettingsData = { id: string; cancellation_cutoff_hours: number; min_booking_days: number; max_booking_days: number | null };
type GrantData = { id: string };

async function login(username: string, password: string) {
  const res = await request<AuthUserResult>('/api/auth/login', { method: 'POST', body: { username, password } });
  expect(res.status, `login ${username}`).toBe(200);
  return res.cookie!;
}

async function seedUser(username: string, role: string, businessId: string | null): Promise<number> {
  const { passwordHash, passwordSalt } = await hashPassword(PASSWORD);
  const row = await testPool.query<{ id: string }>(
    `INSERT INTO auth.users
       (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6, $7, false) RETURNING id`,
    [username, `${username}@test.local`, username, passwordHash, passwordSalt, role, businessId],
  );
  return Number(row.rows[0].id);
}

async function seedClosure(businessId: string, date: string): Promise<number> {
  const row = await testPool.query<{ id: string }>(
    `INSERT INTO schedule_exceptions (business_id, exception_date, is_unavailable)
     VALUES ($1, $2::date, true) RETURNING id`,
    [businessId, date],
  );
  return Number(row.rows[0].id);
}

async function seedGrant(professionalUserId: number, granteeUserId: number): Promise<number> {
  const row = await testPool.query<{ id: string }>(
    `INSERT INTO calendar_grants (professional_user_id, grantee_user_id) VALUES ($1, $2) RETURNING id`,
    [professionalUserId, granteeUserId],
  );
  return Number(row.rows[0].id);
}

async function closureExists(id: number): Promise<boolean> {
  const row = await testPool.query(`SELECT 1 FROM schedule_exceptions WHERE id = $1`, [id]);
  return row.rows.length > 0;
}

// The closure response projection omits business_id (it is never client-facing), so the stamped
// tenant is read back from the row.
async function closureBusinessOf(id: number): Promise<string | null> {
  const row = await testPool.query<{ business_id: string | null }>(
    `SELECT business_id FROM schedule_exceptions WHERE id = $1`,
    [id],
  );
  return row.rows[0]?.business_id ?? null;
}

async function grantExists(id: number): Promise<boolean> {
  const row = await testPool.query(`SELECT 1 FROM calendar_grants WHERE id = $1`, [id]);
  return row.rows.length > 0;
}

async function cutoffOf(businessId: string): Promise<number> {
  const row = await testPool.query<{ cancellation_cutoff_hours: number }>(
    `SELECT cancellation_cutoff_hours FROM businesses WHERE id = $1`,
    [businessId],
  );
  return row.rows[0].cancellation_cutoff_hours;
}

// Latest audit business_id for an event carrying a numeric entity_id (closures, grants).
async function auditByEntity(eventType: string, entityId: number) {
  const row = await testPool.query<{ business_id: string | null }>(
    `SELECT business_id FROM audit_events WHERE event_type = $1 AND entity_id = $2 ORDER BY id DESC LIMIT 1`,
    [eventType, entityId],
  );
  return row.rows[0];
}

// business_settings_updated carries no entity_id; its tenant lives in details.business_id.
async function auditSettings(businessId: string) {
  const row = await testPool.query<{ business_id: string | null }>(
    `SELECT business_id FROM audit_events
      WHERE event_type = 'business_settings_updated' AND (details ->> 'business_id')::bigint = $1
      ORDER BY id DESC LIMIT 1`,
    [businessId],
  );
  return row.rows[0];
}

let bizA: string;
let bizB: string;
let superCookie: string;
let adminACookie: string;
let proB: number;
let proB2: number;
let recepB: number;
let recepB2: number;
let recepA: number;

beforeAll(async () => {
  await resetTestDb();
  testPool = makeTestPool();
  installTestProxy();
  await runMigrations(testPool, DEFAULT_MIGRATIONS_DIR);

  bizA = (await testPool.query<{ id: string }>(`INSERT INTO businesses (name) VALUES ('Tenant A') RETURNING id`)).rows[0].id;
  bizB = (await testPool.query<{ id: string }>(`INSERT INTO businesses (name) VALUES ('Tenant B') RETURNING id`)).rows[0].id;

  await seedUser('dw_super', 'Admin', null);
  await seedUser('dw_admin_a', 'Admin', bizA);
  proB = await seedUser('dw_pro_b', 'Professional', bizB);
  proB2 = await seedUser('dw_pro_b2', 'Professional', bizB);
  recepB = await seedUser('dw_recep_b', 'Receptionist', bizB);
  recepB2 = await seedUser('dw_recep_b2', 'Receptionist', bizB);
  recepA = await seedUser('dw_recep_a', 'Receptionist', bizA);

  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  superCookie = await login('dw_super', PASSWORD);
  adminACookie = await login('dw_admin_a', PASSWORD);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await testPool.end();
});

describe('business closures — super-admin across tenants', () => {
  test('creates a closure in the named tenant, filed under that tenant', async () => {
    const res = await request<ClosureData>('/api/business-closures', {
      method: 'POST',
      cookie: superCookie,
      body: { exception_date: '2026-08-03', target_business_id: Number(bizB) },
    });
    expect(res.status).toBe(201);
    expect(await closureBusinessOf(Number(dataOf(res).id))).toBe(bizB);
    expect((await auditByEntity('closure_created', Number(dataOf(res).id))).business_id).toBe(bizB);
  });

  test('a create with no named tenant is refused, nothing written', async () => {
    const res = await request<ClosureData>('/api/business-closures', {
      method: 'POST',
      cookie: superCookie,
      body: { exception_date: '2026-08-04' },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).detail?.key).toBe('targetBusinessRequired');
  });

  test('updates a tenant closure and files the event under that tenant', async () => {
    const id = await seedClosure(bizB, '2026-08-05');
    const res = await request<ClosureData>(`/api/business-closures/${id}`, {
      method: 'PUT',
      cookie: superCookie,
      body: { exception_date: '2026-08-06', reason: 'Holiday' },
    });
    expect(res.status).toBe(200);
    expect((await auditByEntity('closure_updated', id)).business_id).toBe(bizB);
  });

  test('deletes a tenant closure and files the event under that tenant', async () => {
    const id = await seedClosure(bizB, '2026-08-07');
    const res = await request(`/api/business-closures/${id}`, { method: 'DELETE', cookie: superCookie });
    expect(res.status).toBe(200);
    expect(await closureExists(id)).toBe(false);
    expect((await auditByEntity('closure_deleted', id)).business_id).toBe(bizB);
  });
});

describe('business closures — tenant Admin unchanged', () => {
  test('naming another tenant on create is refused', async () => {
    const res = await request<ClosureData>('/api/business-closures', {
      method: 'POST',
      cookie: adminACookie,
      body: { exception_date: '2026-08-08', target_business_id: Number(bizB) },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).detail?.key).toBe('targetBusinessNotAllowed');
  });

  test('its own create is stamped with its session business', async () => {
    const res = await request<ClosureData>('/api/business-closures', {
      method: 'POST',
      cookie: adminACookie,
      body: { exception_date: '2026-08-09' },
    });
    expect(res.status).toBe(201);
    expect(await closureBusinessOf(Number(dataOf(res).id))).toBe(bizA);
  });

  test('a foreign closure is absent for update and delete alike (404), and survives', async () => {
    const id = await seedClosure(bizB, '2026-08-10');

    const put = await request(`/api/business-closures/${id}`, {
      method: 'PUT', cookie: adminACookie, body: { exception_date: '2026-08-11' },
    });
    expect(put.status).toBe(404);

    const del = await request(`/api/business-closures/${id}`, { method: 'DELETE', cookie: adminACookie });
    expect(del.status).toBe(404);

    expect(await closureExists(id)).toBe(true);
  });
});

describe('business settings — super-admin across tenants', () => {
  test('reads and patches a tenant it does not belong to, filed under that tenant', async () => {
    const get = await request<SettingsData>(`/api/businesses/${bizB}/settings`, { method: 'GET', cookie: superCookie });
    expect(get.status).toBe(200);

    const res = await request<SettingsData>(`/api/businesses/${bizB}/settings`, {
      method: 'PATCH',
      cookie: superCookie,
      body: { cancellation_cutoff_hours: 48, min_booking_days: 1 },
    });
    expect(res.status).toBe(200);
    expect(dataOf(res).cancellation_cutoff_hours).toBe(48);
    expect(await cutoffOf(bizB)).toBe(48);
    expect((await auditSettings(bizB)).business_id).toBe(bizB);
  });

  test('an unknown tenant is 404, not a leak', async () => {
    const res = await request(`/api/businesses/999999/settings`, {
      method: 'PATCH', cookie: superCookie, body: { cancellation_cutoff_hours: 12, min_booking_days: 0 },
    });
    expect(res.status).toBe(404);
  });
});

describe('business settings — tenant Admin unchanged', () => {
  test('a foreign tenant is absent (404), and its cutoff is untouched', async () => {
    const before = await cutoffOf(bizB);
    const res = await request(`/api/businesses/${bizB}/settings`, {
      method: 'PATCH', cookie: adminACookie, body: { cancellation_cutoff_hours: 3, min_booking_days: 0 },
    });
    expect(res.status).toBe(404);
    expect(await cutoffOf(bizB)).toBe(before);
  });

  test('its own tenant patches normally', async () => {
    const res = await request<SettingsData>(`/api/businesses/${bizA}/settings`, {
      method: 'PATCH', cookie: adminACookie, body: { cancellation_cutoff_hours: 6, min_booking_days: 0 },
    });
    expect(res.status).toBe(200);
    expect(await cutoffOf(bizA)).toBe(6);
  });
});

describe('calendar grants — super-admin across tenants', () => {
  test('creates a grant in the tenant that owns the professional, filed under that tenant', async () => {
    const res = await request<GrantData>('/api/calendar-grants', {
      method: 'POST',
      cookie: superCookie,
      body: { professional_user_id: proB, grantee_user_id: recepB },
    });
    expect(res.status).toBe(201);
    expect((await auditByEntity('grant_created', Number(dataOf(res).id))).business_id).toBe(bizB);
  });

  test('a grantee outside the tenant that owns the professional cannot bridge two businesses', async () => {
    const res = await request<GrantData>('/api/calendar-grants', {
      method: 'POST',
      cookie: superCookie,
      body: { professional_user_id: proB, grantee_user_id: recepA },
    });
    expect(res.status).toBe(422);
    expect(errorOf(res).detail?.key).toBe('granteeNotFound');
  });

  test('revokes a tenant grant and files the event under that tenant', async () => {
    const id = await seedGrant(proB, recepB2);
    const res = await request(`/api/calendar-grants/${id}`, { method: 'DELETE', cookie: superCookie });
    expect(res.status).toBe(200);
    expect(await grantExists(id)).toBe(false);
    expect((await auditByEntity('grant_revoked', id)).business_id).toBe(bizB);
  });
});

describe('calendar grants — tenant Admin unchanged', () => {
  test('a professional in another tenant is absent for create (404)', async () => {
    const res = await request<GrantData>('/api/calendar-grants', {
      method: 'POST',
      cookie: adminACookie,
      body: { professional_user_id: proB, grantee_user_id: recepB },
    });
    expect(res.status).toBe(404);
    expect(errorOf(res).detail?.key).toBe('professionalNotFound');
  });

  test('a foreign grant is absent for revoke (404), and survives', async () => {
    const id = await seedGrant(proB2, recepB);
    const res = await request(`/api/calendar-grants/${id}`, { method: 'DELETE', cookie: adminACookie });
    expect(res.status).toBe(404);
    expect(await grantExists(id)).toBe(true);
  });
});
