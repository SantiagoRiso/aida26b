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

type ReqBody = Record<string, string | number | boolean | null>;
// Wire shape: fields come back over JSON, not coerced to the app-side TableRecordMap types
// (e.g. starts_at is a string here, not a Date).
type AppointmentRow = {
  id: string;
  client_user_id: string;
  professional_user_id: string;
  starts_at: string;
};
type Envelope = {
  success?: boolean;
  data?: Record<string, string | number | boolean | null> | AppointmentRow[];
  meta?: { page: number; limit: number; total: number };
  error?: { code: string; message: string; fields?: Record<string, string> };
};

async function apptReq(method: 'GET' | 'POST' | 'PATCH', path: string, body?: ReqBody) {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const response = await fetch(`${baseUrl}${path}`, opts);
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Envelope) : null };
}

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

  const svc = await pool.query<{ id: string }>(
    `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
     VALUES ($1, 'Consulta', 30, '1500.00') RETURNING id`,
    [bizId],
  );
  svcId = Number(svc.rows[0].id);

  const block = await pool.query<{ id: string }>(
    `INSERT INTO schedule_blocks (professional_user_id, weekday, start_time, end_time)
     VALUES ($1, 'mon', '09:00', '12:00') RETURNING id`,
    [proId],
  );
  await pool.query(
    `INSERT INTO schedule_block_services (professional_user_id, schedule_block_id, service_id)
     VALUES ($1, $2, $3)`,
    [proId, block.rows[0].id, svcId],
  );

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

function requestBody(overrides: ReqBody = {}) {
  return {
    professional_user_id: proId,
    service_id: svcId,
    date: MONDAY,
    start: '09:00',
    duration_minutes: 30,
    ...overrides,
  };
}

describe('POST /api/appointments/request', () => {
  test('creates a requested appointment with correct fields', async () => {
    currentUser = asUser(clientId, 'Client');
    const res = await apptReq('POST', '/api/appointments/request', requestBody());
    expect(res.status).toBe(201);
    expect(res.body.data.state).toBe('requested');
    expect(res.body.data.override_conflict).toBe(false);
    // staff fields stripped from client-facing payload
    expect(res.body.data.staff_note).toBeUndefined();
    expect(res.body.data.override_actor_id).toBeUndefined();
    // price captured from resolveBooking
    expect(res.body.data.price).toBe('1500.00');
    expect(res.body.data.resource_id).toBeNull();

    await pool.query(`DELETE FROM appointments WHERE id = $1`, [res.body.data.id]);
  });

  test('conflicting slot returns 200 verdict with can_override=false and writes no row', async () => {
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
  test('clash without override returns 200 verdict and writes no row (warn-first)', async () => {
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

  test('override=true on a conflict-free slot does not mark the row as a sobreturno', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('POST', '/api/appointments/schedule', requestBody({
      start: '11:30',
      override: true,
      client_user_id: client2Id,
    }));
    expect(res.status).toBe(201);
    expect(res.body.data.override_conflict).toBe(false);
    expect(res.body.data.override_actor_id).toBeNull();

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

describe('POST /api/appointments/:id/approve', () => {
  test('approve on now-clashing slot returns 200 verdict without writing', async () => {
    const requested = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, '${mondayAt('09:30')}', 30, 'requested', '1500.00', false)
       RETURNING id`,
      [clientId, proId, svcId],
    );
    const requestedId = Number(requested.rows[0].id);

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
  test('requested → completed is illegal (422)', async () => {
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

  test('DB trigger rejects raw illegal state UPDATE (backstop)', async () => {
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

describe('POST /api/appointments/:id/transition — timing guard', () => {
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

describe('POST /api/appointments/:id/transition — charge on completion', () => {
  // A past start so the completion timing guard is satisfied.
  const PAST_TS = new Date(Date.now() - 3600 * 1000).toISOString();

  async function insertPastScheduled(): Promise<number> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, $4, 30, 'scheduled', '1500.00', false)
       RETURNING id`,
      [clientId, proId, svcId, PAST_TS],
    );
    return Number(r.rows[0].id);
  }

  async function chargesFor(apptId: number): Promise<{ amount_ars: string }[]> {
    const r = await pool.query<{ amount_ars: string }>(
      `SELECT amount_ars FROM ledger_entries WHERE appointment_id = $1 AND entry_type = 'charge'`,
      [apptId],
    );
    return r.rows;
  }

  test('completing (attended) posts a single charge for the session price', async () => {
    const id = await insertPastScheduled();
    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('POST', `/api/appointments/${id}/transition`, { to: 'completed' });
    expect(res.status).toBe(200);
    const charges = await chargesFor(id);
    expect(charges).toHaveLength(1);
    expect(charges[0].amount_ars).toBe('1500.00');
    // No cleanup: ledger_entries are append-only and the appointment FK would block deletion;
    // the DB is reset per file and later tests query by their own appointment id.
  });

  test('does not double-charge when a charge already exists', async () => {
    const id = await insertPastScheduled();
    await pool.query(
      `INSERT INTO ledger_entries (client_user_id, appointment_id, entry_type, amount_ars, actor_user_id)
       VALUES ($1, $2, 'charge', '1500.00', $3)`,
      [clientId, id, proId],
    );
    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('POST', `/api/appointments/${id}/transition`, { to: 'completed' });
    expect(res.status).toBe(200);
    expect(await chargesFor(id)).toHaveLength(1);
  });

  test('no_show posts no charge', async () => {
    const id = await insertPastScheduled();
    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('POST', `/api/appointments/${id}/transition`, { to: 'no_show' });
    expect(res.status).toBe(200);
    expect(await chargesFor(id)).toHaveLength(0);
    await pool.query(`DELETE FROM appointments WHERE id = $1`, [id]);
  });
});

describe('Client cancellation cutoff', () => {
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

  test('client can withdraw a requested appointment regardless of cutoff', async () => {
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

  test('rejects a reschedule whose start + duration crosses midnight (422)', async () => {
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
      start: '23:30',
      duration_minutes: 60,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_request');
    expect(res.body.error.fields.duration_minutes).toBeTruthy();

    await pool.query(`DELETE FROM appointments WHERE id = $1`, [id]);
  });
});

describe('PATCH /api/appointments/:id — terminal freeze', () => {
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

  test('staff_note update on canceled appointment succeeds', async () => {
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

describe('GET /api/appointments/:id — staff detail read', () => {
  test('client is always 403 regardless of ownership', async () => {
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
    const rows = res.body?.data as AppointmentRow[];
    expect(rows.length).toBeGreaterThan(0);
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
    const rows = res.body?.data as AppointmentRow[];
    for (const row of rows) {
      expect(Number(row.client_user_id)).not.toBe(clientId);
    }
  });

  test('list filters by professional_user_id', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('GET', `/api/appointments?professional_user_id=${proId}`);
    expect(res.status).toBe(200);
    const rows = res.body?.data as AppointmentRow[];
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
    const rows = res.body?.data as AppointmentRow[];
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
    const rows = res.body?.data as AppointmentRow[];
    expect(rows.length).toBeGreaterThan(0);
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
    const rows = res.body?.data as AppointmentRow[];
    for (let i = 1; i < rows.length; i++) {
      expect(new Date(rows[i].starts_at).getTime()).toBeGreaterThanOrEqual(
        new Date(rows[i - 1].starts_at).getTime(),
      );
    }
  });

  test('audit events are written in the same transaction as lifecycle actions', async () => {
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

describe('GET /api/appointments — client_user_id filter & related-clients endpoint', () => {
  let a1: number;
  let a2: number;
  let adminId: number;

  beforeAll(async () => {
    const r1 = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, $4, 30, 'scheduled', '1500.00', false) RETURNING id`,
      [clientId, proId, svcId, FAR_FUTURE_TS],
    );
    a1 = Number(r1.rows[0].id);
    const r2 = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, $4, 30, 'scheduled', '1600.00', false) RETURNING id`,
      [client2Id, proId, svcId, new Date(farFutureDate.getTime() + 3600 * 1000).toISOString()],
    );
    a2 = Number(r2.rows[0].id);
    adminId = await seedUser('appt_admin_rc', 'Admin');
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM appointments WHERE id = ANY($1)`, [[a1, a2]]);
  });

  test('staff filter by client_user_id returns only that client’s turnos', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('GET', `/api/appointments?client_user_id=${clientId}`);
    expect(res.status).toBe(200);
    const rows = res.body?.data as AppointmentRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(Number(row.client_user_id)).toBe(clientId);
  });

  test('a Client cannot widen scope via client_user_id (stays self-scoped)', async () => {
    currentUser = asUser(clientId, 'Client');
    const res = await apptReq('GET', `/api/appointments?client_user_id=${client2Id}`);
    expect(res.status).toBe(200);
    const rows = res.body?.data as AppointmentRow[];
    // The param is ignored for a Client — they still only ever see their own rows.
    for (const row of rows) expect(Number(row.client_user_id)).toBe(clientId);
  });

  test('non-numeric client_user_id → 422', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('GET', '/api/appointments?client_user_id=abc');
    expect(res.status).toBe(422);
  });

  test('related-clients resolves (not shadowed by /:id) and lists distinct ids', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await apptReq('GET', '/api/appointments/related-clients');
    expect(res.status).toBe(200);
    const ids: number[] = res.body.data.client_user_ids;
    expect(Array.isArray(ids)).toBe(true);
    expect(ids).toContain(clientId);
    expect(ids).toContain(client2Id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('related-clients for a professional is scoped to their own calendar', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('GET', '/api/appointments/related-clients');
    expect(res.status).toBe(200);
    expect(res.body.data.client_user_ids).toEqual(expect.arrayContaining([clientId, client2Id]));
  });

  test('related-clients for a receptionist without a grant is empty', async () => {
    currentUser = asUser(recepNoGrantId, 'Receptionist');
    const res = await apptReq('GET', '/api/appointments/related-clients');
    expect(res.status).toBe(200);
    expect(res.body.data.client_user_ids).toHaveLength(0);
  });

  test('related-clients is forbidden for the Client role', async () => {
    currentUser = asUser(clientId, 'Client');
    const res = await apptReq('GET', '/api/appointments/related-clients');
    expect(res.status).toBe(403);
  });
});

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

describe('POST /api/appointments/:id/reschedule — authz before state check (WR-06)', () => {
  test('unauthorized caller on a terminal appointment gets 403, not 422', async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, $4, 30, 'canceled', '1500.00', false)
       RETURNING id`,
      [clientId, proId, svcId, FAR_FUTURE_TS],
    );
    const id = Number(r.rows[0].id);

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

describe('POST /api/appointments/schedule — foreign resource_id (WR-02)', () => {
  let foreignResourceId: number;

  beforeAll(async () => {
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

describe('GET /api/appointments?state= — state filter', () => {
  const REQ_TS = new Date(Date.now() + 370 * 24 * 3600 * 1000).toISOString();
  const SCHED_TS = new Date(Date.now() + 371 * 24 * 3600 * 1000).toISOString();
  let reqId: number;
  let schedId: number;

  beforeAll(async () => {
    const req = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, $4, 30, 'requested', '1500.00', false) RETURNING id`,
      [clientId, proId, svcId, REQ_TS],
    );
    reqId = Number(req.rows[0].id);
    const sched = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, $4, 30, 'scheduled', '1500.00', false) RETURNING id`,
      [clientId, proId, svcId, SCHED_TS],
    );
    schedId = Number(sched.rows[0].id);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM appointments WHERE id IN ($1, $2)`, [reqId, schedId]);
  });

  test('state=requested returns only requested rows (includes the requested, excludes the scheduled)', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('GET', '/api/appointments?state=requested&limit=200');
    expect(res.status).toBe(200);
    const rows = res.body.data as { id: number | string; state: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.state === 'requested')).toBe(true);
    expect(rows.some((r) => Number(r.id) === reqId)).toBe(true);
    expect(rows.some((r) => Number(r.id) === schedId)).toBe(false);
  });

  test('unknown state → 422', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await apptReq('GET', '/api/appointments?state=bogus');
    expect(res.status).toBe(422);
  });
});
