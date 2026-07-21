import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { mountSchedulingRoutes } from '../src/routes/scheduling';
import { mountAppointmentRoutes } from '../src/routes/appointments';
import { addDaysISO, BUSINESS_TZ } from '../src/time';
import type { AuthUser } from '../src/auth';
import { makeApiClient, dataOf, errorOf } from './api_client';
import type { AvailabilityResult, BookingWindowResult } from '../../shared/src/ssot/contracts/scheduling';
import type { AppointmentResponse } from '../../shared/src/ssot/query-types';

// Client self-service is bounded by the booking window; staff are exempt. The professional here
// works every weekday, so any future date is a working day and only the window governs the result.

let pool: Pool;
let server: http.Server;
let baseUrl: string;
let currentUser: AuthUser;

const injectUser: express.RequestHandler = (req, _res, next) => {
  (req as express.Request & { user?: AuthUser }).user = currentUser;
  next();
};

const request = makeApiClient(() => baseUrl);

const MAX_DAYS = 30;
let bizId: string;
let proId: number;
let clientId: number;
let serviceId: number;
let today: string;
let inWindow: string;
let outWindow: string;

const staffUser = (): AuthUser => ({
  id: 100000, username: 'admin', email: null, role: 'Admin',
  business_id: Number(bizId), is_active: true, must_change_password: false,
});
const clientCaller = (): AuthUser => ({
  id: clientId, username: 'client', email: null, role: 'Client',
  business_id: Number(bizId), is_active: true, must_change_password: false,
});

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const biz = await pool.query<{ id: string }>(`INSERT INTO businesses (name) VALUES ('Window Biz') RETURNING id`);
  bizId = biz.rows[0].id;
  // Bounded window: today .. today + 30 days.
  await pool.query(`UPDATE businesses SET min_booking_days = 0, max_booking_days = $2 WHERE id = $1`, [bizId, MAX_DAYS]);

  const pro = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ('win_pro', 'win_pro@test.local', 'Dr. Win', 'h', 's', 'Professional', $1, false) RETURNING id`,
    [bizId],
  );
  proId = Number(pro.rows[0].id);

  const client = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ('win_client', 'win_client@test.local', 'Cli Win', 'h', 's', 'Client', $1, false) RETURNING id`,
    [bizId],
  );
  clientId = Number(client.rows[0].id);

  const svc = await pool.query<{ id: string }>(
    `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
     VALUES ($1, 'Consulta', 15, '1000.00') RETURNING id`,
    [bizId],
  );
  serviceId = Number(svc.rows[0].id);

  // Works every weekday 09:00-12:00, so any future date is a working day.
  for (const weekday of ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']) {
    const block = await pool.query<{ id: string }>(
      `INSERT INTO schedule_blocks (professional_user_id, weekday, start_time, end_time)
       VALUES ($1, $2, '09:00', '12:00') RETURNING id`,
      [proId, weekday],
    );
    await pool.query(
      `INSERT INTO schedule_block_services (professional_user_id, schedule_block_id, service_id)
       VALUES ($1, $2, $3)`,
      [proId, block.rows[0].id, serviceId],
    );
  }

  today = new Date().toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });
  inWindow = addDaysISO(today, 5);
  outWindow = addDaysISO(today, MAX_DAYS + 15);

  const app = express();
  app.use(express.json());
  const passwordReady: express.RequestHandler = (_req, _res, next) => next();
  const guards = { auth: injectUser, passwordReady, audit: async () => {} };
  mountSchedulingRoutes(app, pool, guards);
  mountAppointmentRoutes(app, pool, guards);

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

describe('GET /api/availability booking window', () => {
  test('a Client gets no slots and outside_window for a date past the window', async () => {
    currentUser = clientCaller();
    const res = await request<AvailabilityResult>(`/api/availability?owner=prof:${proId}&date=${outWindow}&service=${serviceId}`);
    expect(res.status).toBe(200);
    expect(dataOf(res).slots).toHaveLength(0);
    expect(dataOf(res).open).toBe(false);
    expect(dataOf(res).outside_window).toBe(true);
  });

  test('staff are exempt: the same out-of-window date returns real slots', async () => {
    currentUser = staffUser();
    const res = await request<AvailabilityResult>(`/api/availability?owner=prof:${proId}&date=${outWindow}&service=${serviceId}`);
    expect(res.status).toBe(200);
    expect(dataOf(res).slots.length).toBeGreaterThan(0);
    expect(dataOf(res).outside_window).toBeUndefined();
  });

  test('a Client gets real slots for a date inside the window', async () => {
    currentUser = clientCaller();
    const res = await request<AvailabilityResult>(`/api/availability?owner=prof:${proId}&date=${inWindow}&service=${serviceId}`);
    expect(res.status).toBe(200);
    expect(dataOf(res).slots.length).toBeGreaterThan(0);
    expect(dataOf(res).outside_window).toBeFalsy();
  });
});

describe('GET /api/booking-window', () => {
  test('returns the concrete min/max dates for the professional+service', async () => {
    currentUser = clientCaller();
    const res = await request<BookingWindowResult>(`/api/booking-window?professional=${proId}&service=${serviceId}`);
    expect(res.status).toBe(200);
    expect(dataOf(res).min_date).toBe(today);
    expect(dataOf(res).max_date).toBe(addDaysISO(today, MAX_DAYS));
  });

  test('rejects a missing professional with 422', async () => {
    currentUser = clientCaller();
    const res = await request<BookingWindowResult>(`/api/booking-window?service=${serviceId}`);
    expect(res.status).toBe(422);
  });
});

describe('POST /api/appointments/request booking window', () => {
  test('a Client requesting past the window is rejected with 422 outside_booking_window', async () => {
    currentUser = clientCaller();
    const res = await request<AppointmentResponse>('/api/appointments/request', {
      method: 'POST',
      body: { professional_user_id: proId, service_id: serviceId, date: outWindow, start: '09:00', duration_minutes: 15 },
    });
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe('outside_booking_window');
  });
});
