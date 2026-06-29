import * as asserts from './test_assertions';
import * as fixtures from './test_objects';
import { createApp } from '../src/app';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, test, expect } from 'vitest';

const TESTS_PORT = 4137;
export const API_BASE = `http://localhost:${TESTS_PORT}/api`;

let server: any;
let testsPool: Pool;
let businessId: string;
let userId: string;

beforeAll(async () => {
  await resetTestDb();
  testsPool = makeTestPool();
  await runMigrations(testsPool, DEFAULT_MIGRATIONS_DIR);

  const business = await testsPool.query<{ id: string }>(
    `INSERT INTO businesses (name) VALUES ('Test Business') RETURNING id`
  );
  businessId = business.rows[0].id;

  const user = await testsPool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, password_hash, password_salt, role, business_id)
     VALUES ('seed_client', 'seed@test.com', 'h', 's', 'Client', $1) RETURNING id`,
    [businessId]
  );
  userId = user.rows[0].id;

  const app = createApp(testsPool);
  server = app.listen(TESTS_PORT);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
});

afterEach(async () => {
  await testsPool.query(
    `TRUNCATE TABLE client_professional_services, schedule_exceptions, schedules,
       appointments, ledger_entries, clients, professionals, resources, services
     RESTART IDENTITY CASCADE`
  );
});

afterAll(async () => {
  await testsPool.end();
  server.close();
});

test('GET /clients on empty db returns an empty list', async () => {
  await asserts.toGetAnEmptyTable('clients');
});

test('GET /professionals on empty db returns an empty list', async () => {
  await asserts.toGetAnEmptyTable('professionals');
});

test('GET /services on empty db returns an empty list', async () => {
  await asserts.toGetAnEmptyTable('services');
});

test('POST & GET /clients inserts a client into an empty db', async () => {
  await asserts.toGetAnEmptyTable('clients');
  const created = await asserts.insertedCorrectly('clients', fixtures.clientFor(businessId, userId));
  await asserts.fetchedByIdMatches('clients', created.id, fixtures.clientFor(businessId, userId));
  await asserts.tableContainsCount('clients', 1);
});

test('POST & GET /professionals inserts a professional into an empty db', async () => {
  await asserts.toGetAnEmptyTable('professionals');
  const created = await asserts.insertedCorrectly('professionals', fixtures.professionalFor(businessId));
  await asserts.fetchedByIdMatches('professionals', created.id, fixtures.professionalFor(businessId));
});

test('POST & GET /services inserts a service into an empty db', async () => {
  await asserts.toGetAnEmptyTable('services');
  const created = await asserts.insertedCorrectly('services', fixtures.serviceFor(businessId));
  await asserts.fetchedByIdMatches('services', created.id, fixtures.serviceFor(businessId));
});

test('DELETE /clients removes the row', async () => {
  const created = await asserts.insertedCorrectly('clients', fixtures.clientFor(businessId, userId));
  await asserts.deletedCorrectly('clients', created.id);
  await asserts.toGetAnEmptyTable('clients');
});

test('DELETE /services removes the row', async () => {
  const created = await asserts.insertedCorrectly('services', fixtures.serviceFor(businessId));
  await asserts.deletedCorrectly('services', created.id);
  await asserts.toGetAnEmptyTable('services');
});

test('PUT /clients updates the row', async () => {
  const created = await asserts.insertedCorrectly('clients', fixtures.clientFor(businessId, userId));
  await asserts.updatedCorrectly('clients', created.id, fixtures.clientModifiedFor(businessId, userId));
  await asserts.fetchedByIdMatches('clients', created.id, fixtures.clientModifiedFor(businessId, userId));
});

test('PUT /professionals updates the row', async () => {
  const created = await asserts.insertedCorrectly('professionals', fixtures.professionalFor(businessId));
  await asserts.updatedCorrectly('professionals', created.id, fixtures.professionalModifiedFor(businessId));
});

test('PUT /services updates the row', async () => {
  const created = await asserts.insertedCorrectly('services', fixtures.serviceFor(businessId));
  await asserts.updatedCorrectly('services', created.id, fixtures.serviceModifiedFor(businessId));
});

test('duplicate client_professional_services assignment returns conflict', async () => {
  const client = await asserts.insertedCorrectly('clients', fixtures.clientFor(businessId, userId));
  const professional = await asserts.insertedCorrectly('professionals', fixtures.professionalFor(businessId));
  const service = await asserts.insertedCorrectly('services', fixtures.serviceFor(businessId));
  const assignment = fixtures.clientPriceFor(client.id, professional.id, service.id);

  await asserts.insertedCorrectly('client_professional_services', assignment);
  await asserts.duplicateRejected('client_professional_services', assignment);
});

test('DELETE on a soft-deletable entity archives the row instead of removing it', async () => {
  const created = await asserts.insertedCorrectly('clients', fixtures.clientFor(businessId, userId));

  await asserts.deletedCorrectly('clients', created.id);

  await asserts.toGetAnEmptyTable('clients');

  const stored = await testsPool.query(
    `SELECT deleted_at FROM clients WHERE id = $1`,
    [created.id]
  );
  expect(stored.rows.length).toBe(1);
  expect(stored.rows[0].deleted_at).not.toBeNull();
});

test('list responses carry pagination meta', async () => {
  await asserts.insertedCorrectly('services', fixtures.serviceFor(businessId));

  const response = await fetch(`${API_BASE}/services`);
  const body = await response.json();
  expect(body.success).toBe(true);
  expect(body.meta).toMatchObject({ page: 1, limit: 20, total: 1 });
});
