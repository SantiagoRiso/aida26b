import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { mountSchedulingRoutes } from '../src/routes/scheduling';
import type { AuthUser } from '../src/auth';
import { makeApiClient, dataOf, errorOf } from './api_client';
import type { AvailabilityResult, ConflictCheckResult } from '../../shared/src/ssot/contracts/scheduling';

// Minimal app with pass-through guards and a swappable current user — createApp mounts only
// generic routes, so the workflow endpoints are exercised via their own mount function here.
let pool: Pool;
let server: http.Server;
let baseUrl: string;
let currentUser: AuthUser;

const injectUser: express.RequestHandler = (req, _res, next) => {
  (req as express.Request & { user?: AuthUser }).user = currentUser;
  next();
};

const request = makeApiClient(() => baseUrl);

const MONDAY = '2026-06-29';
let bizId: string;
let proId: number;
let clientId: number;
let serviceId: number;

const staffUser = (): AuthUser => ({
  id: 100000,
  username: 'admin',
  email: null,
  role: 'Admin',
  business_id: Number(bizId),
  is_active: true,
  must_change_password: false,
});

const clientCaller = (): AuthUser => ({
  id: clientId,
  username: 'client',
  email: null,
  role: 'Client',
  business_id: Number(bizId),
  is_active: true,
  must_change_password: false,
});

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const biz = await pool.query<{ id: string }>(`INSERT INTO businesses (name) VALUES ('Conflict Biz') RETURNING id`);
  bizId = biz.rows[0].id;

  const pro = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ('conf_pro', 'conf_pro@test.local', 'Dr. Ana', 'h', 's', 'Professional', $1, false) RETURNING id`,
    [bizId]
  );
  proId = Number(pro.rows[0].id);

  const client = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ('conf_client', 'conf_client@test.local', 'Cli Ent', 'h', 's', 'Client', $1, false) RETURNING id`,
    [bizId]
  );
  clientId = Number(client.rows[0].id);

  const svc = await pool.query<{ id: string }>(
    `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
     VALUES ($1, 'Consulta', 15, '1000.00') RETURNING id`,
    [bizId]
  );
  serviceId = Number(svc.rows[0].id);

  const block = await pool.query<{ id: string }>(
    `INSERT INTO schedule_blocks (professional_user_id, weekday, start_time, end_time)
     VALUES ($1, 'mon', '09:00', '12:00') RETURNING id`,
    [proId]
  );
  await pool.query(
    `INSERT INTO schedule_block_services (professional_user_id, schedule_block_id, service_id)
     VALUES ($1, $2, $3)`,
    [proId, block.rows[0].id, serviceId]
  );

  // A scheduled appointment 10:00-10:15 local (UTC-3). ends_at is set by the DB trigger.
  await pool.query(
    `INSERT INTO appointments (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price)
     VALUES ($1, $2, $3, '2026-06-29 10:00:00-03', 15, 'scheduled', 1000.00)`,
    [clientId, proId, serviceId]
  );

  const app = express();
  app.use(express.json());
  mountSchedulingRoutes(app, pool, {
    auth: injectUser,
    passwordReady: (_req, _res, next) => next(),
    audit: async () => {},
  });

  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('POST /api/conflict-check', () => {
  test('a free slot returns can_save:true with no conflicts and effective price/duration', async () => {
    currentUser = staffUser();
    const res = await request<ConflictCheckResult>('/api/conflict-check', {
      method: 'POST',
      body: { professional_user_id: proId, service_id: serviceId, date: MONDAY, start: '11:00', duration_minutes: 15 },
    });
    expect(res.status).toBe(200);
    expect(dataOf(res).can_save).toBe(true);
    expect(dataOf(res).conflicts).toEqual([]);
    expect(dataOf(res).effective_price).toBe('1000.00');
    expect(dataOf(res).effective_duration_minutes).toBe(15);
  });

  test('an already-booked slot returns can_save:false with a professional_overlap', async () => {
    currentUser = staffUser();
    const res = await request<ConflictCheckResult>('/api/conflict-check', {
      method: 'POST',
      body: { professional_user_id: proId, service_id: serviceId, date: MONDAY, start: '10:00', duration_minutes: 15 },
    });
    expect(res.status).toBe(200);
    expect(dataOf(res).can_save).toBe(false);
    expect(dataOf(res).conflicts.some((c) => c.type === 'professional_overlap')).toBe(true);
  });

  test('overlap is end-exclusive: the 10:15 slot adjacent to a 10:00-10:15 booking is free', async () => {
    currentUser = staffUser();
    const res = await request<ConflictCheckResult>('/api/conflict-check', {
      method: 'POST',
      body: { professional_user_id: proId, service_id: serviceId, date: MONDAY, start: '10:15', duration_minutes: 15 },
    });
    expect(res.status).toBe(200);
    expect(dataOf(res).conflicts.some((c) => c.type === 'professional_overlap')).toBe(false);
    expect(dataOf(res).can_save).toBe(true);
  });

  test('can_override is false for a Client and true for staff', async () => {
    const body = { professional_user_id: proId, service_id: serviceId, date: MONDAY, start: '10:00', duration_minutes: 15 };

    currentUser = clientCaller();
    const asClient = await request<ConflictCheckResult>('/api/conflict-check', { method: 'POST', body });
    expect(dataOf(asClient).can_override).toBe(false);
    expect(dataOf(asClient).requires_override).toBe(true);

    currentUser = staffUser();
    const asStaff = await request<ConflictCheckResult>('/api/conflict-check', { method: 'POST', body });
    expect(dataOf(asStaff).can_override).toBe(true);
  });

  test('rejects malformed input with 422 and a fields map', async () => {
    currentUser = staffUser();
    const res = await request<ConflictCheckResult>('/api/conflict-check', {
      method: 'POST',
      body: { professional_user_id: proId, service_id: serviceId, date: 'nope', start: '99:99', duration_minutes: 0 },
    });
    expect(res.status).toBe(422);
    expect(errorOf(res).fields).toBeTruthy();
  });
});

describe('GET /api/availability', () => {
  test('returns discrete free slots excluding the booked slot', async () => {
    currentUser = staffUser();
    const res = await request<AvailabilityResult>(`/api/availability?owner=prof:${proId}&date=${MONDAY}&service=${serviceId}`);
    expect(res.status).toBe(200);
    expect(dataOf(res).date).toBe(MONDAY);
    const slots = dataOf(res).slots;
    expect(slots.length).toBe(11); // 12 grid slots minus the booked 10:00-10:15
    expect(slots.find((s) => s.start === '10:00')).toBeUndefined();
    expect(slots.find((s) => s.start === '09:00' && s.end === '09:15')).toBeTruthy();
  });

  test('rejects a malformed owner token with 422', async () => {
    currentUser = staffUser();
    const res = await request<AvailabilityResult>(`/api/availability?owner=bogus&date=${MONDAY}`);
    expect(res.status).toBe(422);
  });

  test('a professional with no service returns raw working windows minus booked (staff shading)', async () => {
    currentUser = staffUser();
    // No `service` param: the endpoint must not 422; it returns the 09:00-12:00 block as contiguous
    // free windows split around the booked 10:00-10:15, not service-sized 15-min slots.
    const res = await request<AvailabilityResult>(`/api/availability?owner=prof:${proId}&date=${MONDAY}`);
    expect(res.status).toBe(200);
    expect(dataOf(res).open).toBe(true);
    expect(dataOf(res).slots).toEqual([
      { start: '09:00', end: '10:00' },
      { start: '10:15', end: '12:00' },
    ]);
  });

  test('exclude=<id> frees the excluded appointment\'s own slot', async () => {
    currentUser = staffUser();

    const appt = await pool.query<{ id: string }>(
      `SELECT id FROM appointments
       WHERE professional_user_id = $1 AND (starts_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = $2::date
       ORDER BY starts_at LIMIT 1`,
      [proId, MONDAY]
    );
    const excludeId = appt.rows[0].id;

    const without = await request<AvailabilityResult>(`/api/availability?owner=prof:${proId}&date=${MONDAY}&service=${serviceId}`);
    expect(dataOf(without).slots.find((s) => s.start === '10:00')).toBeUndefined();

    const withExclude = await request<AvailabilityResult>(`/api/availability?owner=prof:${proId}&date=${MONDAY}&service=${serviceId}&exclude=${excludeId}`);
    const slots = dataOf(withExclude).slots;
    expect(slots.find((s) => s.start === '10:00' && s.end === '10:15')).toBeTruthy();
    expect(slots.length).toBe(12); // full grid, nothing booked once the only appt is excluded
  });

  test('a non-numeric exclude is ignored (no 422)', async () => {
    currentUser = staffUser();
    const res = await request<AvailabilityResult>(`/api/availability?owner=prof:${proId}&date=${MONDAY}&service=${serviceId}&exclude=nope`);
    expect(res.status).toBe(200);
    expect(dataOf(res).slots.find((s) => s.start === '10:00')).toBeUndefined();
  });

  test('open distinguishes a not-worked day from a fully booked one', async () => {
    currentUser = staffUser();

    // Tuesday is not in the weekly schedule: closed.
    const closed = await request<AvailabilityResult>(`/api/availability?owner=prof:${proId}&date=2026-06-30&service=${serviceId}`);
    expect(dataOf(closed).open).toBe(false);
    expect(dataOf(closed).slots).toHaveLength(0);

    // A professional with a single slot that is booked: working day, nothing free.
    const pro2 = await pool.query<{ id: string }>(
      `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
       VALUES ('conf_pro_full', 'conf_pro_full@test.local', 'Dr. Lleno', 'h', 's', 'Professional', $1, false) RETURNING id`,
      [bizId]
    );
    const pro2Id = Number(pro2.rows[0].id);
    const pro2Block = await pool.query<{ id: string }>(
      `INSERT INTO schedule_blocks (professional_user_id, weekday, start_time, end_time)
       VALUES ($1, 'mon', '09:00', '09:15') RETURNING id`,
      [pro2Id]
    );
    await pool.query(
      `INSERT INTO schedule_block_services (professional_user_id, schedule_block_id, service_id)
       VALUES ($1, $2, $3)`,
      [pro2Id, pro2Block.rows[0].id, serviceId]
    );
    await pool.query(
      `INSERT INTO appointments (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price)
       VALUES ($1, $2, $3, '2026-06-29 09:00:00-03', 15, 'scheduled', 1000.00)`,
      [clientId, pro2Id, serviceId]
    );

    const full = await request<AvailabilityResult>(`/api/availability?owner=prof:${pro2Id}&date=${MONDAY}&service=${serviceId}`);
    expect(dataOf(full).open).toBe(true);
    expect(dataOf(full).slots).toHaveLength(0);

    const free = await request<AvailabilityResult>(`/api/availability?owner=prof:${proId}&date=${MONDAY}&service=${serviceId}`);
    expect(dataOf(free).open).toBe(true);
  });
});
