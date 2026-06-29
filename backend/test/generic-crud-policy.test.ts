import { createApp } from '../src/app';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const TESTS_PORT = 4138;
const API_BASE = `http://localhost:${TESTS_PORT}/api`;

let server: any;
let testsPool: Pool;
let businessId: string;
let professionalId: string;

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

  const professional = await testsPool.query<{ id: string }>(
    `INSERT INTO professionals (business_id, display_name) VALUES ($1, 'Pro') RETURNING id`,
    [businessId]
  );
  professionalId = professional.rows[0].id;

  const app = createApp(testsPool);
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

  test('reads are blocked as not_found', async () => {
    for (const entity of protectedEntities) {
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
    const res = await api('/schedules?id=1', { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.body.error.code).toBe('operation_not_allowed');
  });

  test('client_professional_services cannot be deleted generically', async () => {
    const res = await api('/client_professional_services?id=1', { method: 'DELETE' });
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
        professional_id: professionalId,
        resource_id: null,
        exception_date: '2026-07-01',
        is_unavailable: true,
        start_time: null,
        end_time: null,
        reason: null,
      }),
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    const del = await api(`/schedule_exceptions?id=${id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);

    const stored = await testsPool.query(
      `SELECT 1 FROM schedule_exceptions WHERE id = $1`,
      [id]
    );
    expect(stored.rows.length).toBe(0);
  });
});
