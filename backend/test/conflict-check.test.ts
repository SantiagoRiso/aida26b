import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { mountSchedulingRoutes } from '../src/routes/scheduling';
import type { AuthUser } from '../src/auth';

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

async function request(
  path: string,
  { method = 'GET', body }: { method?: string; body?: unknown } = {}
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as any) : null };
}

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

  await pool.query(`INSERT INTO schedules (professional_user_id, weekly) VALUES ($1, $2)`, [
    proId,
    JSON.stringify({ mon: [{ start: '09:00', end: '12:00', granularity_minutes: 15 }] }),
  ]);

  // A scheduled appointment 10:00–10:15 local (UTC-3). ends_at is set by the DB trigger.
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
    const res = await request('/api/conflict-check', {
      method: 'POST',
      body: { professional_user_id: proId, service_id: serviceId, date: MONDAY, start: '11:00', duration_minutes: 15 },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.can_save).toBe(true);
    expect(res.body.data.conflicts).toEqual([]);
    expect(res.body.data.effective_price).toBe('1000.00');
    expect(res.body.data.effective_duration_minutes).toBe(15);
  });

  test('an already-booked slot returns can_save:false with a professional_overlap', async () => {
    currentUser = staffUser();
    const res = await request('/api/conflict-check', {
      method: 'POST',
      body: { professional_user_id: proId, service_id: serviceId, date: MONDAY, start: '10:00', duration_minutes: 15 },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.can_save).toBe(false);
    expect(res.body.data.conflicts.some((c: any) => c.type === 'professional_overlap')).toBe(true);
  });

  test('overlap is end-exclusive: the 10:15 slot adjacent to a 10:00-10:15 booking is free', async () => {
    currentUser = staffUser();
    const res = await request('/api/conflict-check', {
      method: 'POST',
      body: { professional_user_id: proId, service_id: serviceId, date: MONDAY, start: '10:15', duration_minutes: 15 },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.conflicts.some((c: any) => c.type === 'professional_overlap')).toBe(false);
    expect(res.body.data.can_save).toBe(true);
  });

  test('can_override is false for a Client and true for staff', async () => {
    const body = { professional_user_id: proId, service_id: serviceId, date: MONDAY, start: '10:00', duration_minutes: 15 };

    currentUser = clientCaller();
    const asClient = await request('/api/conflict-check', { method: 'POST', body });
    expect(asClient.body.data.can_override).toBe(false);
    expect(asClient.body.data.requires_override).toBe(true);

    currentUser = staffUser();
    const asStaff = await request('/api/conflict-check', { method: 'POST', body });
    expect(asStaff.body.data.can_override).toBe(true);
  });

  test('rejects malformed input with 422 and a fields map', async () => {
    currentUser = staffUser();
    const res = await request('/api/conflict-check', {
      method: 'POST',
      body: { professional_user_id: proId, service_id: serviceId, date: 'nope', start: '99:99', duration_minutes: 0 },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toBeTruthy();
  });
});

describe('GET /api/availability', () => {
  test('returns discrete free slots excluding the booked slot', async () => {
    currentUser = staffUser();
    const res = await request(`/api/availability?owner=prof:${proId}&date=${MONDAY}`);
    expect(res.status).toBe(200);
    expect(res.body.data.date).toBe(MONDAY);
    const slots = res.body.data.slots as Array<{ start: string; end: string }>;
    expect(slots.length).toBe(11); // 12 grid slots minus the booked 10:00-10:15
    expect(slots.find((s) => s.start === '10:00')).toBeUndefined();
    expect(slots.find((s) => s.start === '09:00' && s.end === '09:15')).toBeTruthy();
  });

  test('rejects a malformed owner token with 422', async () => {
    currentUser = staffUser();
    const res = await request(`/api/availability?owner=bogus&date=${MONDAY}`);
    expect(res.status).toBe(422);
  });
});
