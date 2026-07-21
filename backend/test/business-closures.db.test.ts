import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { mountSchedulingRoutes } from '../src/routes/scheduling';
import { mountBusinessClosureRoutes } from '../src/routes/business-closures';
import type { AuthUser } from '../src/auth';
import { makeApiClient, dataOf } from './api_client';
import type { AvailabilityResult } from '../../shared/src/ssot/contracts/scheduling';

// Lightweight app with pass-through guards and a swappable current user — the same pattern
// conflict-check uses, mounting both the availability route and the closures route so a closure's
// effect on availability is exercised end-to-end.
let pool: Pool;
let server: http.Server;
let baseUrl: string;
let currentUser: AuthUser;

const injectUser: express.RequestHandler = (req, _res, next) => {
  (req as express.Request & { user?: AuthUser }).user = currentUser;
  next();
};

type ClosureData = { id: string; exception_date: string; start_time: string | null; end_time: string | null; reason: string | null };
type DeleteData = { id: string; deleted: boolean };
const request = makeApiClient(() => baseUrl);

const MONDAY = '2026-06-29';
let bizId: string;
let proId: number;
let serviceId: number;

const admin = (): AuthUser => ({
  id: 100000, username: 'admin', email: null, role: 'Admin',
  business_id: Number(bizId), is_active: true, must_change_password: false,
});
const professional = (): AuthUser => ({
  id: proId, username: 'pro', email: null, role: 'Professional',
  business_id: Number(bizId), is_active: true, must_change_password: false,
});

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const biz = await pool.query<{ id: string }>(`INSERT INTO businesses (name) VALUES ('Closure Biz') RETURNING id`);
  bizId = biz.rows[0].id;

  const pro = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ('clo_pro', 'clo_pro@test.local', 'Dr. Clo', 'h', 's', 'Professional', $1, false) RETURNING id`,
    [bizId]
  );
  proId = Number(pro.rows[0].id);

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

  const app = express();
  app.use(express.json());
  const guards = {
    auth: injectUser,
    passwordReady: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    audit: async () => {},
  };
  mountSchedulingRoutes(app, pool, guards);
  mountBusinessClosureRoutes(app, pool, guards);

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

async function availabilitySlotCount(): Promise<number> {
  currentUser = admin();
  const res = await request<AvailabilityResult>(`/api/availability?owner=prof:${proId}&date=${MONDAY}&service=${serviceId}`);
  expect(res.status).toBe(200);
  return dataOf(res).slots.length;
}

describe('business-wide closures', () => {
  test('a non-admin cannot create a business closure', async () => {
    currentUser = professional();
    const res = await request<ClosureData>('/api/business-closures', { method: 'POST', body: { exception_date: MONDAY } });
    expect(res.status).toBe(403);
  });

  test('a partial closure needs both endpoints or neither', async () => {
    currentUser = admin();
    const res = await request<ClosureData>('/api/business-closures', { method: 'POST', body: { exception_date: MONDAY, start_time: '13:00' } });
    expect(res.status).toBe(422);
  });

  test('an admin closure blocks every professional that day, and deleting it reopens the day', async () => {
    // Baseline: the professional has bookable slots.
    expect(await availabilitySlotCount()).toBeGreaterThan(0);

    // Admin closes the whole clinic.
    currentUser = admin();
    const created = await request<ClosureData>('/api/business-closures', {
      method: 'POST',
      body: { exception_date: MONDAY, reason: 'Feriado nacional' },
    });
    expect(created.status).toBe(201);
    const closureId = dataOf(created).id;

    // The closure unions into the professional's availability → no slots left.
    expect(await availabilitySlotCount()).toBe(0);

    // It is listed for the Negocio management UI (one closure, this tenant).
    currentUser = admin();
    const list = await request<ClosureData[]>('/api/business-closures');
    expect(list.status).toBe(200);
    expect(dataOf(list).length).toBe(1);

    // Deleting it reopens the day.
    currentUser = admin();
    const del = await request<DeleteData>(`/api/business-closures/${closureId}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(await availabilitySlotCount()).toBeGreaterThan(0);
  });
});

describe('business closure update', () => {
  test('an admin edits a closure (date/time/reason); a non-admin cannot', async () => {
    currentUser = admin();
    const created = await request<ClosureData>('/api/business-closures', { method: 'POST', body: { exception_date: '2026-06-30', reason: 'Original' } });
    expect(created.status).toBe(201);
    const id = dataOf(created).id;

    currentUser = professional();
    const denied = await request<ClosureData>(`/api/business-closures/${id}`, { method: 'PUT', body: { exception_date: '2026-06-30' } });
    expect(denied.status).toBe(403);

    currentUser = admin();
    const updated = await request<ClosureData>(`/api/business-closures/${id}`, {
      method: 'PUT',
      body: { exception_date: '2026-07-01', start_time: '10:00', end_time: '12:00', reason: 'Editado' },
    });
    expect(updated.status).toBe(200);
    const row = dataOf(updated);
    expect(row).toMatchObject({ exception_date: '2026-07-01', start_time: '10:00', end_time: '12:00', reason: 'Editado' });

    await request<DeleteData>(`/api/business-closures/${id}`, { method: 'DELETE' });
  });

  test('an inverted time range is rejected, and a missing closure is 404', async () => {
    currentUser = admin();
    const created = await request<ClosureData>('/api/business-closures', { method: 'POST', body: { exception_date: '2026-06-30' } });
    const id = dataOf(created).id;

    const bad = await request<ClosureData>(`/api/business-closures/${id}`, { method: 'PUT', body: { exception_date: '2026-06-30', start_time: '12:00', end_time: '09:00' } });
    expect(bad.status).toBe(422);
    await request<DeleteData>(`/api/business-closures/${id}`, { method: 'DELETE' });

    const missing = await request<ClosureData>('/api/business-closures/999999', { method: 'PUT', body: { exception_date: '2026-07-01' } });
    expect(missing.status).toBe(404);
  });
});
