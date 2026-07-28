import type { Server } from 'node:http';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { createApp } from '../src/app';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool, makeAppPool } from './helpers';
import type { AuthUser } from '../src/auth';
import { makeApiClient, dataOf, errorOf } from './api_client';
import type { GenericRow } from '../../shared/src/ssot/query-types';

// Sweeps the "adjacent cases" alongside the reported username-conflict issue: every other
// unique/CHECK constraint reachable through generic CRUD (see
// shared/src/ssot/domain/constraint-messages.ts, CONSTRAINT_DETAIL_KEYS) used to collapse to the
// same opaque "Ya existe un registro con esos datos.". These prove each one now carries its own
// detail.key. A cross-tenant super-admin fixture keeps authz out of the way; the point here is the
// error shape, not scoping (already covered by generic-crud-policy.db.test.ts and friends).

// id is a placeholder until beforeAll seeds the row and overwrites it: the generic writes below
// are audited against this actor, so it must be a real auth.users row (see src/audit.ts).
const superAdmin: AuthUser = {
  id: 0,
  username: 'constraint-admin',
  email: null,
  role: 'Admin',
  business_id: null,
  is_active: true,
  must_change_password: false,
};

let testsPool: Pool;
let appPool: Pool;
let server: Server;
let baseUrl: string;

let businessId: number;
let proId: number;
let clientId: number;
let serviceId: number;
let resourceId: number;

const request = makeApiClient(() => baseUrl);

async function seedUser(username: string, role: 'Professional' | 'Client', biz: number): Promise<number> {
  const r = await testsPool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ($1, $2, $3, 'h', 's', $4, $5, false) RETURNING id`,
    [username, `${username}@test.local`, username, role, biz],
  );
  return Number(r.rows[0].id);
}

beforeAll(async () => {
  await resetTestDb();
  testsPool = makeTestPool();
  await runMigrations(testsPool, DEFAULT_MIGRATIONS_DIR);

  const biz = await testsPool.query<{ id: string }>(`INSERT INTO businesses (name) VALUES ('Constraint Biz') RETURNING id`);
  businessId = Number(biz.rows[0].id);

  proId = await seedUser('constraint_pro', 'Professional', businessId);
  clientId = await seedUser('constraint_client', 'Client', businessId);

  const svc = await testsPool.query<{ id: string }>(
    `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
     VALUES ($1, 'Constraint Svc', 30, '500.00') RETURNING id`,
    [businessId],
  );
  serviceId = Number(svc.rows[0].id);

  const resource = await testsPool.query<{ id: string }>(
    `INSERT INTO resources (business_id, name) VALUES ($1, 'Constraint Room') RETURNING id`,
    [businessId],
  );
  resourceId = Number(resource.rows[0].id);

  const superAdminUser = await testsPool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id)
     VALUES ('constraint_super_admin', 'super@constraint.test', 'Constraint Super Admin', 'h', 's', 'Admin', NULL) RETURNING id`,
  );
  superAdmin.id = Number(superAdminUser.rows[0].id);

  appPool = makeAppPool();
  const app = createApp(appPool, { defaultUser: superAdmin });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await appPool.end();
  await testsPool.end();
});

describe('professional_services_unique', () => {
  test('offering the same service to the same professional twice → 409 serviceAlreadyOffered', async () => {
    const body = { professional_user_id: String(proId), service_id: String(serviceId), min_booking_days: null, max_booking_days: null };
    const first = await request<GenericRow>('/api/professional_services', { method: 'POST', body });
    expect(first.status).toBe(201);

    const second = await request<GenericRow>('/api/professional_services', { method: 'POST', body });
    expect(second.status).toBe(409);
    expect(errorOf(second).detail?.key).toBe('serviceAlreadyOffered');
  });
});

describe('client_professional_services_unique', () => {
  test('a second price override for the same client/professional/service → 409 clientPriceOverrideExists', async () => {
    const first = await request<GenericRow>('/api/client_professional_services', {
      method: 'POST',
      body: {
        client_user_id: String(clientId),
        professional_user_id: String(proId),
        service_id: String(serviceId),
        price_ars: '400.00',
      },
    });
    expect(first.status).toBe(201);

    const second = await request<GenericRow>('/api/client_professional_services', {
      method: 'POST',
      body: {
        client_user_id: String(clientId),
        professional_user_id: String(proId),
        service_id: String(serviceId),
        price_ars: '450.00',
      },
    });
    expect(second.status).toBe(409);
    expect(errorOf(second).detail?.key).toBe('clientPriceOverrideExists');
  });
});

describe('schedule_blocks_time_order', () => {
  test('end_time at or before start_time → 400 endAfterStart', async () => {
    const res = await request<GenericRow>('/api/schedule_blocks', {
      method: 'POST',
      body: {
        professional_user_id: String(proId),
        resource_id: null,
        weekday: 'wed',
        start_time: '15:00',
        end_time: '15:00',
      },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).detail?.key).toBe('endAfterStart');
  });
});

describe('schedule_blocks_one_owner', () => {
  // "Neither owner" is already refused earlier, at 422, by the app-level ownership guard
  // (assertOwnScheduleAllowed) before a write is even attempted. That guard only inspects
  // professional_user_id first, so "both owners" sails through it (it resolves as a professional
  // write) and is the DB CHECK's actual job: catching a body that names both.
  test('both a professional and a resource named → 400 scheduleOwnerExactlyOne', async () => {
    const res = await request<GenericRow>('/api/schedule_blocks', {
      method: 'POST',
      body: {
        professional_user_id: String(proId),
        resource_id: String(resourceId),
        weekday: 'thu',
        start_time: '09:00',
        end_time: '10:00',
      },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).detail?.key).toBe('scheduleOwnerExactlyOne');
  });
});

describe('schedule_block_services_unique', () => {
  test('attaching the same service to a block twice → 409 blockServiceAlreadyOffered', async () => {
    const block = await request<GenericRow>('/api/schedule_blocks', {
      method: 'POST',
      body: {
        professional_user_id: String(proId),
        resource_id: null,
        weekday: 'fri',
        start_time: '09:00',
        end_time: '12:00',
      },
    });
    expect(block.status).toBe(201);
    const blockId = String(dataOf(block).id);

    const body = { professional_user_id: String(proId), schedule_block_id: blockId, service_id: String(serviceId), duration_minutes: null, price_ars: null };
    const first = await request<GenericRow>('/api/schedule_block_services', { method: 'POST', body });
    expect(first.status).toBe(201);

    const second = await request<GenericRow>('/api/schedule_block_services', { method: 'POST', body });
    expect(second.status).toBe(409);
    expect(errorOf(second).detail?.key).toBe('blockServiceAlreadyOffered');
  });
});

describe('schedule_exceptions_time_range_check', () => {
  test('end_time before start_time on a time-off window → 400 endAfterStart', async () => {
    const res = await request<GenericRow>('/api/schedule_exceptions', {
      method: 'POST',
      body: {
        professional_user_id: String(proId),
        resource_id: null,
        exception_date: '2026-08-10',
        is_unavailable: true,
        start_time: '12:00',
        end_time: '09:00',
        granularity_minutes: null,
        reason: null,
      },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).detail?.key).toBe('endAfterStart');
  });
});

describe('schedule_exceptions_granularity_check', () => {
  test('an "available" (changed-hours) exception with no granularity → 400 exceptionGranularityRequired', async () => {
    const res = await request<GenericRow>('/api/schedule_exceptions', {
      method: 'POST',
      body: {
        professional_user_id: String(proId),
        resource_id: null,
        exception_date: '2026-08-11',
        is_unavailable: false,
        start_time: '09:00',
        end_time: '13:00',
        granularity_minutes: null,
        reason: null,
      },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).detail?.key).toBe('exceptionGranularityRequired');
  });
});

describe('schedule_exceptions_one_owner', () => {
  // Same shape as schedule_blocks_one_owner above: "neither" is refused earlier (422, app-level
  // ownership guard); "both" reaches the DB, which is where num_nonnulls(...) = 1 does its job.
  test('both a professional and a resource named → 400 scheduleOwnerExactlyOne', async () => {
    const res = await request<GenericRow>('/api/schedule_exceptions', {
      method: 'POST',
      body: {
        professional_user_id: String(proId),
        resource_id: String(resourceId),
        exception_date: '2026-08-12',
        is_unavailable: true,
        start_time: null,
        end_time: null,
        granularity_minutes: null,
        reason: null,
      },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).detail?.key).toBe('scheduleOwnerExactlyOne');
  });
});
