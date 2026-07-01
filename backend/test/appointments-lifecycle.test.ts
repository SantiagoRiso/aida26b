import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { mountAppointmentRoutes } from '../src/routes/appointments';
import type { AuthUser } from '../src/auth';

let pool: Pool;
let server: http.Server;
let baseUrl: string;
let currentUser: AuthUser;

const injectUser: express.RequestHandler = (req, _res, next) => {
  (req as express.Request & { user?: AuthUser }).user = currentUser;
  next();
};

async function apptReq(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const response = await fetch(`${baseUrl}${path}`, opts);
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as any) : null };
}

// ── Seed identifiers ──────────────────────────────────────────────────────────
let bizId: number;
let svcId: number;
let proId: number;
let pro2Id: number;
let clientId: number;
let client2Id: number;
let recepNoGrantId: number;
let recepWithGrantId: number;

const BA_TZ = 'America/Argentina/Buenos_Aires';

// The professional's schedule only has Monday slots — anchor grid bookings to the
// next Monday from now so the suite never rots against a frozen calendar date.
function nextMondayDate(): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  const daysUntilMonday = ((8 - d.getUTCDay()) % 7) || 7;
  d.setUTCDate(d.getUTCDate() + daysUntilMonday);
  return d.toISOString().slice(0, 10);
}
const MONDAY = nextMondayDate();
const mondayAt = (hhmm: string) => `${MONDAY} ${hhmm}:00 ${BA_TZ}`;

// Off-grid raw-inserted appointment, far enough ahead to sit before the
// complete/no_show and cancellation-cutoff "now" guards.
const farFutureDate = new Date(Date.now() + 365 * 24 * 3600 * 1000);
const FAR_FUTURE_TS = farFutureDate.toISOString();

const WEEKLY = JSON.stringify({ mon: [{ start: '09:00', end: '12:00', granularity_minutes: 30 }] });

async function seedUser(
  username: string,
  role: AuthUser['role'],
): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO auth.users
       (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ($1, $2, $3, 'h', 's', $4, $5, false)
     RETURNING id`,
    [username, `${username}@test.local`, username, role, bizId],
  );
  return Number(r.rows[0].id);
}

function asUser(id: number, role: AuthUser['role']): AuthUser {
  return {
    id,
    username: `u${id}`,
    email: null,
    role,
    business_id: bizId,
    is_active: true,
    must_change_password: false,
  };
}

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  // Business with cutoff=0 initially.
  const biz = await pool.query<{ id: string }>(
    `INSERT INTO businesses (name, cancellation_cutoff_hours) VALUES ('Appt Biz', 0) RETURNING id`,
  );
  bizId = Number(biz.rows[0].id);

  proId = await seedUser('appt_pro1', 'Professional');
  pro2Id = await seedUser('appt_pro2', 'Professional');
  clientId = await seedUser('appt_client1', 'Client');
  client2Id = await seedUser('appt_client2', 'Client');
  recepNoGrantId = await seedUser('appt_recep_no', 'Receptionist');
  recepWithGrantId = await seedUser('appt_recep_yes', 'Receptionist');

  // Schedule for pro1 (Monday 09:00–12:00, 30-min slots).
  await pool.query(`INSERT INTO schedules (professional_user_id, weekly) VALUES ($1, $2)`, [
    proId,
    WEEKLY,
  ]);

  // Service belonging to the test business.
  const svc = await pool.query<{ id: string }>(
    `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
     VALUES ($1, 'Consulta', 30, '1500.00') RETURNING id`,
    [bizId],
  );
  svcId = Number(svc.rows[0].id);

  // Receptionist grant: recepWithGrant → pro1's calendar.
  await pool.query(
    `INSERT INTO calendar_grants (professional_user_id, grantee_user_id) VALUES ($1, $2)`,
    [proId, recepWithGrantId],
  );

  const app = express();
  app.use(express.json());
  mountAppointmentRoutes(app, pool, {
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
  currentUser = asUser(clientId, 'Client');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ── Helper: build a standard request body for pro1 ───────────────────────────
function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    professional_user_id: proId,
    service_id: svcId,
    date: MONDAY,
    start: '09:00',
    duration_minutes: 30,
    ...overrides,
  };
}

// ── Task 1: Create endpoints ──────────────────────────────────────────────────

describe('POST /api/appointments/request', () => {
  test('creates a requested appointment with correct fields', async () => {
    currentUser = asUser(clientId, 'Client');
    const res = await apptReq('POST', '/api/appointments/request', requestBody());
    expect(res.status).toBe(201);
    expect(res.body.data.state).toBe('requested');
    expect(res.body.data.override_conflict).toBe(false);
    // staff fields stripped from client-facing payload (D-08/D-31)
    expect(res.body.data.staff_note).toBeUndefined();
    expect(res.body.data.override_actor_id).toBeUndefined();
    // price captured from resolveBooking
    expect(res.body.data.price).toBe('1500.00');
    // resource_id omitted in client request (D-09)
    expect(res.body.data.resource_id).toBeNull();

    // cleanup
    await pool.query(`DELETE FROM appointments WHERE id = $1`, [res.body.data.id]);
  });

  test('conflicting slot returns 200 verdict with can_override=false and writes no row', async () => {
    // Block 09:00 with a scheduled appointment.
    const blocker = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, '${mondayAt('09:00')}', 30, 'scheduled', '1500.00', false)
       RETURNING id`,
      [clientId, proId, svcId],
    );

    const countBefore = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM appointments WHERE professional_user_id = $1 AND state = 'requested'`,
      [proId],
    );

    currentUser = asUser(client2Id, 'Client');
    const res = await apptReq('POST', '/api/appointments/request', requestBody());
    expect(res.status).toBe(200);
    expect(res.body.data.requires_override).toBe(true);
    expect(res.body.data.can_override).toBe(false);

    // No new row written.
    const countAfter = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM appointments WHERE professional_user_id = $1 AND state = 'requested'`,
      [proId],
    );
    expect(countAfter.rows[0].n).toBe(countBefore.rows[0].n);

    await pool.query(`DELETE FROM appointments WHERE id = $1`, [Number(blocker.rows[0].id)]);
  });

  test('non-client caller is rejected (403)', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('POST', '/api/appointments/request', requestBody());
    expect(res.status).toBe(403);
  });
});

describe('POST /api/appointments/schedule', () => {
  test('clash without override returns 200 verdict and writes no row (warn-first, D-03)', async () => {
    const blocker = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, '${mondayAt('10:00')}', 30, 'scheduled', '1500.00', false)
       RETURNING id`,
      [clientId, proId, svcId],
    );

    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('POST', '/api/appointments/schedule', requestBody({ start: '10:00' }));
    expect(res.status).toBe(200);
    expect(res.body.data.requires_override).toBe(true);

    // No new row written.
    const check = await pool.query(
      `SELECT id FROM appointments
       WHERE professional_user_id = $1
         AND starts_at = '${mondayAt('10:00')}'
         AND state = 'scheduled'
         AND id != $2`,
      [proId, Number(blocker.rows[0].id)],
    );
    expect(check.rows).toHaveLength(0);

    await pool.query(`DELETE FROM appointments WHERE id = $1`, [Number(blocker.rows[0].id)]);
  });

  test('clash with override=true commits and records override_actor_id', async () => {
    const blocker = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, '${mondayAt('11:00')}', 30, 'scheduled', '1500.00', false)
       RETURNING id`,
      [clientId, proId, svcId],
    );

    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('POST', '/api/appointments/schedule', requestBody({
      start: '11:00',
      override: true,
      client_user_id: client2Id,
    }));
    expect(res.status).toBe(201);
    expect(res.body.data.state).toBe('scheduled');
    expect(res.body.data.override_conflict).toBe(true);
    // DB returns IDs as strings; compare as numbers.
    expect(Number(res.body.data.override_actor_id)).toBe(proId);

    await pool.query(`DELETE FROM appointments WHERE id = $1`, [Number(blocker.rows[0].id)]);
    await pool.query(`DELETE FROM appointments WHERE id = $1`, [res.body.data.id]);
  });

  test('professional cannot schedule on another professional calendar (403)', async () => {
    currentUser = asUser(pro2Id, 'Professional');
    const res = await apptReq('POST', '/api/appointments/schedule', requestBody());
    expect(res.status).toBe(403);
  });

  test('receptionist without grant cannot schedule (403)', async () => {
    currentUser = asUser(recepNoGrantId, 'Receptionist');
    const res = await apptReq('POST', '/api/appointments/schedule', requestBody());
    expect(res.status).toBe(403);
  });

  test('receptionist with grant can schedule on a free slot (201)', async () => {
    // Use a clean slot (09:30 — all prior tests clean up 09:00).
    currentUser = asUser(recepWithGrantId, 'Receptionist');
    const res = await apptReq('POST', '/api/appointments/schedule', requestBody({
      start: '09:30',
      client_user_id: clientId,
    }));
    expect(res.status).toBe(201);
    expect(res.body.data.state).toBe('scheduled');
    await pool.query(`DELETE FROM appointments WHERE id = $1`, [res.body.data.id]);
  });
});

describe('cross-business tenant isolation on /schedule (CR-03)', () => {
  let foreignClientId: number;

  beforeAll(async () => {
    const biz2 = await pool.query<{ id: string }>(
      `INSERT INTO businesses (name, cancellation_cutoff_hours) VALUES ('Other Appt Biz', 0) RETURNING id`,
    );
    const biz2Id = Number(biz2.rows[0].id);
    const fc = await pool.query<{ id: string }>(
      `INSERT INTO auth.users
         (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
       VALUES ('appt_foreign_client', 'appt_foreign@test.local', 'foreign', 'h', 's', 'Client', $1, false)
       RETURNING id`,
      [biz2Id],
    );
    foreignClientId = Number(fc.rows[0].id);
  });

  test('staff cannot schedule for a client in another business → 404', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('POST', '/api/appointments/schedule', requestBody({
      start: '11:30',
      client_user_id: foreignClientId,
    }));
    expect(res.status).toBe(404);
  });
});

// ── Task 2: Transitions ───────────────────────────────────────────────────────

describe('POST /api/appointments/:id/approve', () => {
  test('approve on now-clashing slot returns 200 verdict without writing (D-03)', async () => {
    const requested = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, '${mondayAt('09:30')}', 30, 'requested', '1500.00', false)
       RETURNING id`,
      [clientId, proId, svcId],
    );
    const requestedId = Number(requested.rows[0].id);

    // Seed a conflicting scheduled appointment at the same slot.
    const blocker = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, '${mondayAt('09:30')}', 30, 'scheduled', '1500.00', false)
       RETURNING id`,
      [client2Id, proId, svcId],
    );

    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('POST', `/api/appointments/${requestedId}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.body.data.requires_override).toBe(true);

    // Appointment stays requested.
    const check = await pool.query<{ state: string }>(
      `SELECT state FROM appointments WHERE id = $1`,
      [requestedId],
    );
    expect(check.rows[0].state).toBe('requested');

    await pool.query(`DELETE FROM appointments WHERE id IN ($1, $2)`, [requestedId, Number(blocker.rows[0].id)]);
  });

  test('approve with override=true transitions to scheduled and sets override_actor_id', async () => {
    const requested = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, '${mondayAt('09:00')}', 30, 'requested', '1500.00', false)
       RETURNING id`,
      [clientId, proId, svcId],
    );
    const requestedId = Number(requested.rows[0].id);

    const blocker = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, '${mondayAt('09:00')}', 30, 'scheduled', '1500.00', false)
       RETURNING id`,
      [client2Id, proId, svcId],
    );

    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('POST', `/api/appointments/${requestedId}/approve`, { override: true });
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe('scheduled');
    expect(Number(res.body.data.override_actor_id)).toBe(proId);

    await pool.query(`DELETE FROM appointments WHERE id IN ($1, $2)`, [requestedId, Number(blocker.rows[0].id)]);
  });
});

describe('POST /api/appointments/:id/transition — illegal transitions', () => {
  test('requested → completed is illegal (422, D-10)', async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, $4, 30, 'requested', '1500.00', false)
       RETURNING id`,
      [clientId, proId, svcId, FAR_FUTURE_TS],
    );
    const id = Number(r.rows[0].id);

    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('POST', `/api/appointments/${id}/transition`, { to: 'completed' });
    expect(res.status).toBe(422);

    await pool.query(`DELETE FROM appointments WHERE id = $1`, [id]);
  });

  test('DB trigger rejects raw illegal state UPDATE (backstop, D-10)', async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, $4, 30, 'canceled', '1500.00', false)
       RETURNING id`,
      [clientId, proId, svcId, FAR_FUTURE_TS],
    );
    const id = Number(r.rows[0].id);

    await expect(
      pool.query(`UPDATE appointments SET state = 'requested' WHERE id = $1`, [id]),
    ).rejects.toThrow();

    await pool.query(`DELETE FROM appointments WHERE id = $1`, [id]);
  });
});

describe('POST /api/appointments/:id/transition — timing guard (D-13)', () => {
  test('completing before starts_at → 422', async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, $4, 30, 'scheduled', '1500.00', false)
       RETURNING id`,
      [clientId, proId, svcId, FAR_FUTURE_TS],
    );
    const id = Number(r.rows[0].id);

    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('POST', `/api/appointments/${id}/transition`, { to: 'completed' });
    expect(res.status).toBe(422);

    await pool.query(`DELETE FROM appointments WHERE id = $1`, [id]);
  });
});

describe('Client cancellation cutoff (D-16/D-17)', () => {
  test('cutoff=0: client can cancel a scheduled appointment any time before starts_at', async () => {
    await pool.query(`UPDATE businesses SET cancellation_cutoff_hours = 0 WHERE id = $1`, [bizId]);

    // Future appointment so we are BEFORE starts_at.
    const r = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, $4, 30, 'scheduled', '1500.00', false)
       RETURNING id`,
      [clientId, proId, svcId, FAR_FUTURE_TS],
    );
    const id = Number(r.rows[0].id);

    currentUser = asUser(clientId, 'Client');
    const res = await apptReq('POST', `/api/appointments/${id}/transition`, { to: 'canceled' });
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe('canceled');
  });

  test('large cutoff: cancel outside the allowed window → 422', async () => {
    // 9999-hour cutoff ensures "now > starts_at - cutoff" for a 2-hour-away appointment.
    await pool.query(`UPDATE businesses SET cancellation_cutoff_hours = 9999 WHERE id = $1`, [bizId]);

    const nearFuture = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const r = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, $4, 30, 'scheduled', '1500.00', false)
       RETURNING id`,
      [clientId, proId, svcId, nearFuture],
    );
    const id = Number(r.rows[0].id);

    currentUser = asUser(clientId, 'Client');
    const res = await apptReq('POST', `/api/appointments/${id}/transition`, { to: 'canceled' });
    expect(res.status).toBe(422);

    await pool.query(`UPDATE businesses SET cancellation_cutoff_hours = 0 WHERE id = $1`, [bizId]);
    await pool.query(`DELETE FROM appointments WHERE id = $1`, [id]);
  });

  test('client can withdraw a requested appointment regardless of cutoff (D-17)', async () => {
    // Large cutoff.
    await pool.query(`UPDATE businesses SET cancellation_cutoff_hours = 9999 WHERE id = $1`, [bizId]);

    const r = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, $4, 30, 'requested', '1500.00', false)
       RETURNING id`,
      [clientId, proId, svcId, FAR_FUTURE_TS],
    );
    const id = Number(r.rows[0].id);

    currentUser = asUser(clientId, 'Client');
    const res = await apptReq('POST', `/api/appointments/${id}/transition`, { to: 'canceled' });
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe('canceled');

    await pool.query(`UPDATE businesses SET cancellation_cutoff_hours = 0 WHERE id = $1`, [bizId]);
  });
});

describe('POST /api/appointments/:id/reschedule', () => {
  test('reschedule re-resolves price + duration and re-runs recheck', async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, '${mondayAt('09:00')}', 30, 'scheduled', '1500.00', false)
       RETURNING id`,
      [clientId, proId, svcId],
    );
    const id = Number(r.rows[0].id);

    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('POST', `/api/appointments/${id}/reschedule`, {
      date: MONDAY,
      start: '10:00',
      duration_minutes: 30,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.price).toBe('1500.00');
    expect(Number(res.body.data.duration_minutes)).toBe(30);

    await pool.query(`DELETE FROM appointments WHERE id = $1`, [id]);
  });
});

describe('PATCH /api/appointments/:id — terminal freeze (D-12)', () => {
  test('name change on canceled appointment → 422', async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict, name)
       VALUES ($1, $2, $3, $4, 30, 'canceled', '1500.00', false, 'old name')
       RETURNING id`,
      [clientId, proId, svcId, FAR_FUTURE_TS],
    );
    const id = Number(r.rows[0].id);

    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('PATCH', `/api/appointments/${id}`, { name: 'new name' });
    expect(res.status).toBe(422);

    await pool.query(`DELETE FROM appointments WHERE id = $1`, [id]);
  });

  test('staff_note update on canceled appointment succeeds (D-31)', async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, $4, 30, 'canceled', '1500.00', false)
       RETURNING id`,
      [clientId, proId, svcId, FAR_FUTURE_TS],
    );
    const id = Number(r.rows[0].id);

    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('PATCH', `/api/appointments/${id}`, { staff_note: 'called patient' });
    expect(res.status).toBe(200);
    expect(res.body.data.staff_note).toBe('called patient');

    await pool.query(`DELETE FROM appointments WHERE id = $1`, [id]);
  });
});

// ── Task 3: Reads ─────────────────────────────────────────────────────────────

describe('GET /api/appointments/:id — staff detail read', () => {
  test('client is always 403 regardless of ownership (D-08)', async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict, staff_note)
       VALUES ($1, $2, $3, $4, 30, 'scheduled', '1500.00', false, 'private note')
       RETURNING id`,
      [clientId, proId, svcId, FAR_FUTURE_TS],
    );
    const id = Number(r.rows[0].id);

    currentUser = asUser(clientId, 'Client');
    const res = await apptReq('GET', `/api/appointments/${id}`);
    expect(res.status).toBe(403);

    await pool.query(`DELETE FROM appointments WHERE id = $1`, [id]);
  });

  test('staff detail read returns full payload including staff_note', async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict, staff_note)
       VALUES ($1, $2, $3, $4, 30, 'scheduled', '1500.00', false, 'staff memo')
       RETURNING id`,
      [clientId, proId, svcId, FAR_FUTURE_TS],
    );
    const id = Number(r.rows[0].id);

    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('GET', `/api/appointments/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.staff_note).toBe('staff memo');

    await pool.query(`DELETE FROM appointments WHERE id = $1`, [id]);
  });
});

describe('GET /api/appointments — paginated list', () => {
  let listApptId: number;

  beforeAll(async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict, staff_note)
       VALUES ($1, $2, $3, $4, 30, 'scheduled', '1500.00', false, 'list note')
       RETURNING id`,
      [clientId, proId, svcId, FAR_FUTURE_TS],
    );
    listApptId = Number(r.rows[0].id);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM appointments WHERE id = $1`, [listApptId]);
  });

  test('client list returns only own appointments and strips staff_note + override_actor_id', async () => {
    currentUser = asUser(clientId, 'Client');
    const res = await apptReq('GET', '/api/appointments');
    expect(res.status).toBe(200);
    const rows = res.body.data as any[];
    expect(rows.length).toBeGreaterThan(0);
    // All rows must belong to this client.
    for (const row of rows) {
      expect(Number(row.client_user_id)).toBe(clientId);
      expect(row).not.toHaveProperty('staff_note');
      expect(row).not.toHaveProperty('override_actor_id');
    }
  });

  test('client2 list returns no rows from client1 appointments', async () => {
    currentUser = asUser(client2Id, 'Client');
    const res = await apptReq('GET', '/api/appointments');
    expect(res.status).toBe(200);
    const rows = res.body.data as any[];
    for (const row of rows) {
      expect(Number(row.client_user_id)).not.toBe(clientId);
    }
  });

  test('list filters by professional_user_id', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('GET', `/api/appointments?professional_user_id=${proId}`);
    expect(res.status).toBe(200);
    const rows = res.body.data as any[];
    for (const row of rows) {
      expect(Number(row.professional_user_id)).toBe(proId);
    }
  });

  test('list filters by date range (date_from/date_to)', async () => {
    currentUser = asUser(proId, 'Professional');
    const dayBefore = new Date(farFutureDate.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    const dayAfter = new Date(farFutureDate.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    const res = await apptReq('GET', `/api/appointments?date_from=${dayBefore}&date_to=${dayAfter}T23:59:59Z`);
    expect(res.status).toBe(200);
    const rows = res.body.data as any[];
    expect(rows.length).toBeGreaterThan(0);
    const from = new Date(`${dayBefore}T00:00:00Z`).getTime();
    const to = new Date(`${dayAfter}T23:59:59Z`).getTime();
    for (const row of rows) {
      const t = new Date(row.starts_at).getTime();
      expect(t).toBeGreaterThanOrEqual(from);
      expect(t).toBeLessThanOrEqual(to);
    }
  });

  test('receptionist list is limited to granted calendar appointments', async () => {
    currentUser = asUser(recepWithGrantId, 'Receptionist');
    const res = await apptReq('GET', '/api/appointments');
    expect(res.status).toBe(200);
    const rows = res.body.data as any[];
    expect(rows.length).toBeGreaterThan(0);
    // All must be on pro1's calendar (the only granted one).
    for (const row of rows) {
      expect(Number(row.professional_user_id)).toBe(proId);
    }
  });

  test('receptionist without grant sees no appointments', async () => {
    currentUser = asUser(recepNoGrantId, 'Receptionist');
    const res = await apptReq('GET', '/api/appointments');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  test('list is ordered by starts_at ascending', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('GET', '/api/appointments');
    expect(res.status).toBe(200);
    const rows = res.body.data as any[];
    for (let i = 1; i < rows.length; i++) {
      expect(new Date(rows[i].starts_at).getTime()).toBeGreaterThanOrEqual(
        new Date(rows[i - 1].starts_at).getTime(),
      );
    }
  });

  test('audit events are written in the same transaction as lifecycle actions (D-14)', async () => {
    // Schedule on a clean future slot to avoid conflicts.
    await pool.query(`INSERT INTO schedules (professional_user_id, weekly) VALUES ($1, $2) ON CONFLICT (professional_user_id) DO NOTHING`, [proId, WEEKLY]);

    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('POST', '/api/appointments/schedule', {
      professional_user_id: proId,
      service_id: svcId,
      date: MONDAY,
      start: '11:00',
      duration_minutes: 30,
      client_user_id: clientId,
    });
    expect(res.status).toBe(201);
    const apptId = res.body.data.id;

    const audit = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit_events WHERE entity_id = $1 AND entity_type = 'appointments'`,
      [apptId],
    );
    expect(audit.rows.some((r) => r.event_type === 'appointment_scheduled')).toBe(true);

    await pool.query(`DELETE FROM appointments WHERE id = $1`, [apptId]);
  });
});

// ── WR-04 regression: malformed date_from/date_to → 422 ──────────────────────

describe('GET /api/appointments — malformed date filters (WR-04)', () => {
  test('malformed date_from returns 422 invalid_request', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('GET', '/api/appointments?date_from=notadate');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_request');
  });

  test('malformed date_to returns 422 invalid_request', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('GET', '/api/appointments?date_to=2024/01/01');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_request');
  });

  test('valid ISO timestamp date_from still returns 200', async () => {
    currentUser = asUser(proId, 'Professional');
    const iso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const res = await apptReq('GET', `/api/appointments?date_from=${encodeURIComponent(iso)}`);
    expect(res.status).toBe(200);
  });
});

// ── WR-06 regression: unauthorized caller on terminal appointment → 403 ───────

describe('POST /api/appointments/:id/reschedule — authz before state check (WR-06)', () => {
  test('unauthorized caller on a terminal appointment gets 403, not 422', async () => {
    // Insert a canceled (terminal) appointment on pro1's calendar.
    const r = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, $4, 30, 'canceled', '1500.00', false)
       RETURNING id`,
      [clientId, proId, svcId, FAR_FUTURE_TS],
    );
    const id = Number(r.rows[0].id);

    // recepNoGrantId has no grant for pro1 — should get 403, not 422.
    currentUser = asUser(recepNoGrantId, 'Receptionist');
    const res = await apptReq('POST', `/api/appointments/${id}/reschedule`, {
      date: MONDAY,
      start: '09:00',
      duration_minutes: 30,
    });
    expect(res.status).toBe(403);

    await pool.query(`DELETE FROM appointments WHERE id = $1`, [id]);
  });
});

// ── WR-02 regression: foreign resource_id → 404 ──────────────────────────────

describe('POST /api/appointments/schedule — foreign resource_id (WR-02)', () => {
  let foreignResourceId: number;

  beforeAll(async () => {
    // Create a resource belonging to a different business.
    const biz3 = await pool.query<{ id: string }>(
      `INSERT INTO businesses (name, cancellation_cutoff_hours) VALUES ('Resource Biz', 0) RETURNING id`,
    );
    const biz3Id = Number(biz3.rows[0].id);
    const res = await pool.query<{ id: string }>(
      `INSERT INTO resources (business_id, name) VALUES ($1, 'Foreign Room') RETURNING id`,
      [biz3Id],
    );
    foreignResourceId = Number(res.rows[0].id);
  });

  test('foreign resource_id → 404', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('POST', '/api/appointments/schedule', requestBody({
      start: '09:00',
      resource_id: foreignResourceId,
    }));
    expect(res.status).toBe(404);
  });
});
