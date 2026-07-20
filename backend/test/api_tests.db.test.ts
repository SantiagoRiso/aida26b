import * as asserts from './test_assertions';
import * as fixtures from './test_objects';
import { createApp } from '../src/app';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, test, expect } from 'vitest';
import type { AuthUser } from '../src/auth';
import type { Server } from 'node:http';

const TESTS_PORT = 4137;
export const API_BASE = `http://localhost:${TESTS_PORT}/api`;

let server: Server;
let testsPool: Pool;
let businessId: string;
let clientUserId: string;
let professionalUserId: string;

beforeAll(async () => {
  await resetTestDb();
  testsPool = makeTestPool();
  await runMigrations(testsPool, DEFAULT_MIGRATIONS_DIR);

  const business = await testsPool.query<{ id: string }>(
    `INSERT INTO businesses (name) VALUES ('Test Business') RETURNING id`
  );
  businessId = business.rows[0].id;

  const adminRow = await testsPool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id)
     VALUES ('seed_admin', 'admin@test.com', 'Seed Admin', 'h', 's', 'Admin', $1) RETURNING id`,
    [businessId]
  );
  const defaultUser: AuthUser = {
    id: Number(adminRow.rows[0].id),
    username: 'seed_admin',
    email: 'admin@test.com',
    role: 'Admin',
    business_id: Number(businessId),
    is_active: true,
    must_change_password: false,
  };

  const clientUser = await testsPool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, phone, notes, password_hash, password_salt, role, business_id)
     VALUES ('seed_client', 'seed@test.com', 'Seed Client', '1144440000', 'VIP', 'h', 's', 'Client', $1) RETURNING id`,
    [businessId]
  );
  clientUserId = clientUser.rows[0].id;

  const professionalUser = await testsPool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, bio, password_hash, password_salt, role, business_id)
     VALUES ('seed_professional', 'pro@test.com', 'Seed Professional', 'Senior stylist', 'h', 's', 'Professional', $1) RETURNING id`,
    [businessId]
  );
  professionalUserId = professionalUser.rows[0].id;

  const app = createApp(testsPool, { defaultUser });
  server = app.listen(TESTS_PORT);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
});

afterEach(async () => {
  await testsPool.query(
    `TRUNCATE TABLE client_professional_services, schedule_exceptions,
       schedule_blocks, schedule_block_services,
       appointments, ledger_entries, resources, services
     RESTART IDENTITY CASCADE`
  );
  await testsPool.query(
    `UPDATE auth.users SET deleted_at = NULL, deleted_by_user_id = NULL, updated_at = now(),
       display_name = CASE role WHEN 'Client' THEN 'Seed Client' ELSE 'Seed Professional' END,
       phone = CASE WHEN role = 'Client' THEN '1144440000' ELSE NULL END,
       notes = CASE WHEN role = 'Client' THEN 'VIP' ELSE NULL END,
       bio = CASE WHEN role = 'Professional' THEN 'Senior stylist' ELSE NULL END
     WHERE role IN ('Client', 'Professional')`
  );
});

afterAll(async () => {
  await testsPool.end();
  server.close();
});

test('GET /clients returns the seeded client', async () => {
  const response = await fetch(`${API_BASE}/clients`);
  const body = await response.json();
  expect(body.success).toBe(true);
  expect(Array.isArray(body.data)).toBe(true);
  expect(body.data.length).toBe(1);
  expect(String(body.data[0].id)).toBe(String(clientUserId));
});

test('GET /professionals returns the seeded professional', async () => {
  const response = await fetch(`${API_BASE}/professionals`);
  const body = await response.json();
  expect(body.success).toBe(true);
  expect(Array.isArray(body.data)).toBe(true);
  expect(body.data.length).toBe(1);
  expect(String(body.data[0].id)).toBe(String(professionalUserId));
});

test('GET /services on empty db returns an empty list', async () => {
  await asserts.toGetAnEmptyTable('services');
});

test('POST /clients is disabled (create is via admin endpoint only)', async () => {
  const response = await fetch(`${API_BASE}/clients`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: 'Should Fail', phone: '123' }),
  });
  expect(response.status).toBe(405);
});

test('POST /professionals is disabled (create is via admin endpoint only)', async () => {
  const response = await fetch(`${API_BASE}/professionals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: 'Should Fail', bio: 'test' }),
  });
  expect(response.status).toBe(405);
});

test('GET /clients by id returns the seeded client', async () => {
  await asserts.fetchedByIdMatches('clients', clientUserId, { display_name: 'Seed Client' }, 'id');
});

test('GET /professionals by id returns the seeded professional', async () => {
  await asserts.fetchedByIdMatches('professionals', professionalUserId, { display_name: 'Seed Professional' }, 'id');
});

test('POST /schedule_blocks referencing a professional in another business → 422', async () => {
  const otherBiz = await testsPool.query<{ id: string }>(
    `INSERT INTO businesses (name) VALUES ('Foreign Biz') RETURNING id`
  );
  const foreignPro = await testsPool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id)
     VALUES ('foreign_pro', 'fp@foreign.test', 'Foreign Pro', 'h', 's', 'Professional', $1) RETURNING id`,
    [otherBiz.rows[0].id]
  );

  const response = await fetch(`${API_BASE}/schedule_blocks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      professional_user_id: foreignPro.rows[0].id,
      resource_id: null,
      weekday: 'mon',
      start_time: '09:00',
      end_time: '12:00',
    }),
  });
  expect(response.status).toBe(422);
  const body = await response.json();
  expect(body.error.code).toBe('invalid_reference_role');

  await testsPool.query(`DELETE FROM auth.users WHERE id = $1`, [foreignPro.rows[0].id]);
  await testsPool.query(`DELETE FROM businesses WHERE id = $1`, [otherBiz.rows[0].id]);
});

test('POST & GET /services inserts a service into an empty db', async () => {
  await asserts.toGetAnEmptyTable('services');
  const created = await asserts.insertedCorrectly('services', fixtures.serviceFor(businessId));
  await asserts.fetchedByIdMatches('services', created.id, fixtures.serviceFor(businessId));
});

test('DELETE /clients soft-deletes the row', async () => {
  await asserts.deletedCorrectly('clients', clientUserId);
  const response = await fetch(`${API_BASE}/clients`);
  const body = await response.json();
  expect(body.data.length).toBe(0);

  const stored = await testsPool.query(
    `SELECT deleted_at FROM auth.users WHERE id = $1`,
    [clientUserId]
  );
  expect(stored.rows.length).toBe(1);
  expect(stored.rows[0].deleted_at).not.toBeNull();
});

test('DELETE /services removes the row', async () => {
  const created = await asserts.insertedCorrectly('services', fixtures.serviceFor(businessId));
  await asserts.deletedCorrectly('services', created.id);
  await asserts.toGetAnEmptyTable('services');
});

test('PUT /clients updates profile fields', async () => {
  await asserts.updatedCorrectly('clients', clientUserId, fixtures.clientModifiedFor(clientUserId));
  await asserts.fetchedByIdMatches('clients', clientUserId, fixtures.clientModifiedFor(clientUserId), 'id');
});

test('PUT /professionals updates profile fields', async () => {
  await asserts.updatedCorrectly('professionals', professionalUserId, fixtures.professionalModifiedFor(professionalUserId));
});

test('PUT /services updates the row', async () => {
  const created = await asserts.insertedCorrectly('services', fixtures.serviceFor(businessId));
  await asserts.updatedCorrectly('services', created.id, fixtures.serviceModifiedFor(businessId));
});

test('duplicate client_professional_services assignment returns conflict', async () => {
  const service = await asserts.insertedCorrectly('services', fixtures.serviceFor(businessId));
  const assignment = fixtures.clientPriceFor(clientUserId, professionalUserId, service.id);

  await asserts.insertedCorrectly('client_professional_services', assignment);
  await asserts.duplicateRejected('client_professional_services', assignment);
});

test('list responses carry pagination meta', async () => {
  await asserts.insertedCorrectly('services', fixtures.serviceFor(businessId));

  const response = await fetch(`${API_BASE}/services`);
  const body = await response.json();
  expect(body.success).toBe(true);
  expect(body.meta).toMatchObject({ page: 1, limit: 50, total: 1 });
});
