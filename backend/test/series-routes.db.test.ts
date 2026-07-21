import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { mountAppointmentRoutes } from '../src/routes/appointments';
import type { AuthUser } from '../src/auth';
import { makeApiClient, dataOf, errorOf, metaOf } from './api_client';
import type { JsonBody } from './api_client';
import type {
  AppointmentResponse,
  AppointmentRow,
  AppointmentSeriesRow,
  ListAppointment,
  Wire,
} from '../../shared/src/ssot/query-types';
import type {
  EndSeriesResult,
  MaterializedOccurrenceResult,
  ScheduleSeriesResult,
  SeriesResult,
  SplitSeriesResult,
} from '../../shared/src/ssot/contracts/appointments';

let pool: Pool;
let server: http.Server;
let baseUrl: string;
let currentUser: AuthUser;

const injectUser: express.RequestHandler = (req, _res, next) => {
  (req as express.Request & { user?: AuthUser }).user = currentUser;
  next();
};

type Series = Wire<AppointmentSeriesRow>;
type ListRow = Wire<ListAppointment>;

const request = makeApiClient(() => baseUrl);

function seriesReq<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: JsonBody) {
  return request<T>(path, { method, body });
}

let bizId: number;
let biz2Id: number;
let svcId: number;
let proId: number;
let pro2Id: number;
let pro3Id: number;
let clientId: number;
let recepNoGrantId: number;
let recepWithGrantId: number;

const BA_TZ = 'America/Argentina/Buenos_Aires';

// Anchor the series to the next Monday from now — matches the professional's only available
// block — so the suite never rots against a frozen calendar date.
function nextMondayDate(): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  const daysUntilMonday = ((8 - d.getUTCDay()) % 7) || 7;
  d.setUTCDate(d.getUTCDate() + daysUntilMonday);
  return d.toISOString().slice(0, 10);
}
function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const nd = new Date(Date.UTC(y, m - 1, d + days, 12));
  return nd.toISOString().slice(0, 10);
}
const MONDAY = nextMondayDate();
const SECOND_MONDAY = addDaysISO(MONDAY, 7);

async function seedUser(username: string, role: AuthUser['role'], businessId = bizId): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO auth.users
       (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ($1, $2, $3, 'h', 's', $4, $5, false)
     RETURNING id`,
    [username, `${username}@series-route.local`, username, role, businessId],
  );
  return Number(r.rows[0].id);
}

function asUser(id: number, role: AuthUser['role'], businessId = bizId): AuthUser {
  return {
    id,
    username: `u${id}`,
    email: null,
    role,
    business_id: businessId,
    is_active: true,
    must_change_password: false,
  };
}

function seriesBody(overrides: JsonBody = {}): JsonBody {
  return {
    client_user_id: clientId,
    professional_user_id: proId,
    service_id: svcId,
    frequency: 'weekly',
    interval: 1,
    weekday: 'mon',
    start_time: '09:00',
    duration_minutes: 30,
    start_date: MONDAY,
    end_kind: 'open',
    ...overrides,
  };
}

function createSeries(overrides: JsonBody = {}) {
  return seriesReq<ScheduleSeriesResult<Series>>('POST', '/api/appointments/series', seriesBody(overrides));
}

function materialize(seriesId: string, occurrenceDate: string) {
  return seriesReq<MaterializedOccurrenceResult<Wire<AppointmentRow>>>(
    'POST',
    `/api/appointments/series/${seriesId}/materialize`,
    { occurrence_date: occurrenceDate },
  );
}

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const biz = await pool.query<{ id: string }>(
    `INSERT INTO businesses (name, cancellation_cutoff_hours) VALUES ('Series Route Biz', 0) RETURNING id`,
  );
  bizId = Number(biz.rows[0].id);
  const biz2 = await pool.query<{ id: string }>(
    `INSERT INTO businesses (name, cancellation_cutoff_hours) VALUES ('Series Route Biz 2', 0) RETURNING id`,
  );
  biz2Id = Number(biz2.rows[0].id);

  proId = await seedUser('sr_pro1', 'Professional');
  pro2Id = await seedUser('sr_pro2', 'Professional');
  pro3Id = await seedUser('sr_pro3', 'Professional', biz2Id);
  clientId = await seedUser('sr_client1', 'Client');
  recepNoGrantId = await seedUser('sr_recep_no', 'Receptionist');
  recepWithGrantId = await seedUser('sr_recep_yes', 'Receptionist');

  const svc = await pool.query<{ id: string }>(
    `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
     VALUES ($1, 'Consulta', 30, '1500.00') RETURNING id`,
    [bizId],
  );
  svcId = Number(svc.rows[0].id);

  // Weekly Monday availability for proId — expandSeries anchors to 'mon', matching this block.
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
  currentUser = asUser(proId, 'Professional');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('POST /api/appointments/series — create + preview', () => {
  test('staff create persists the series and returns a preview; a conflicting occurrence is skipped', async () => {
    const blocker = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, '${SECOND_MONDAY} 09:00:00 ${BA_TZ}', 30, 'scheduled', '1500.00', false)
       RETURNING id`,
      [clientId, proId, svcId],
    );

    currentUser = asUser(proId, 'Professional');
    const res = await createSeries();
    expect(res.status).toBe(201);
    const data = dataOf(res);
    expect(data.series.status).toBe('active');
    expect(data.preview.skipped.some((s) => s.date === SECOND_MONDAY)).toBe(true);

    await pool.query(`DELETE FROM appointment_series WHERE id = $1`, [data.series.id]);
    await pool.query(`DELETE FROM appointments WHERE id = $1`, [blocker.rows[0].id]);
  });
});

describe('POST /api/appointments/series — authz', () => {
  test('a Professional creating for themselves succeeds', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await createSeries({ start_date: addDaysISO(MONDAY, 63) });
    expect(res.status).toBe(201);
    await pool.query(`DELETE FROM appointment_series WHERE id = $1`, [dataOf(res).series.id]);
  });

  test('a Professional creating for another professional is denied (403)', async () => {
    currentUser = asUser(pro2Id, 'Professional');
    const res = await createSeries();
    expect(res.status).toBe(403);
  });

  test('an ungranted Receptionist is denied (403)', async () => {
    currentUser = asUser(recepNoGrantId, 'Receptionist');
    const res = await createSeries();
    expect(res.status).toBe(403);
  });

  test('a granted Receptionist succeeds (201)', async () => {
    currentUser = asUser(recepWithGrantId, 'Receptionist');
    const res = await createSeries({ start_date: addDaysISO(MONDAY, 70) });
    expect(res.status).toBe(201);
    await pool.query(`DELETE FROM appointment_series WHERE id = $1`, [dataOf(res).series.id]);
  });
});

describe('POST /api/appointments/series — rule-shape validation', () => {
  test('weekly without weekday → 422', async () => {
    currentUser = asUser(proId, 'Professional');
    const body = seriesBody({ start_date: addDaysISO(MONDAY, 77) });
    delete body.weekday;
    const res = await seriesReq<ScheduleSeriesResult<Series>>('POST', '/api/appointments/series', body);
    expect(res.status).toBe(422);
    expect(errorOf(res).fields?.weekday).toBeTruthy();
  });

  test('monthly_dom with day_of_month=32 → 422', async () => {
    currentUser = asUser(proId, 'Professional');
    const body = seriesBody({
      start_date: addDaysISO(MONDAY, 84),
      frequency: 'monthly_dom',
      day_of_month: 32,
    });
    delete body.weekday;
    const res = await seriesReq<ScheduleSeriesResult<Series>>('POST', '/api/appointments/series', body);
    expect(res.status).toBe(422);
    expect(errorOf(res).fields?.day_of_month).toBeTruthy();
  });
});

describe('series lifecycle: materialize, PUT, future, end', () => {
  let seriesId: string;

  beforeAll(async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await createSeries({ start_date: addDaysISO(MONDAY, 91) });
    expect(res.status).toBe(201);
    seriesId = dataOf(res).series.id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM appointments WHERE series_id = $1`, [seriesId]);
    await pool.query(`DELETE FROM appointment_series WHERE id = $1`, [seriesId]);
  });

  test('materialize returns a scheduled appointment; a second call is idempotent', async () => {
    const occurrenceDate = addDaysISO(MONDAY, 91);
    currentUser = asUser(proId, 'Professional');
    const first = await materialize(seriesId, occurrenceDate);
    expect(first.status).toBe(200);
    const firstAppt = dataOf(first).appointment;
    expect(firstAppt.state).toBe('scheduled');
    expect(firstAppt.series_id).toBe(seriesId);
    expect(firstAppt.occurrence_date).toBe(occurrenceDate);

    const second = await materialize(seriesId, occurrenceDate);
    expect(second.status).toBe(200);
    expect(dataOf(second).appointment.id).toBe(firstAppt.id);
  });

  test.each([
    ['before the series starts', addDaysISO(MONDAY, 84)],
    ['off the recurrence pattern', addDaysISO(MONDAY, 92)],
  ])('rejects a date %s', async (_case, occurrenceDate) => {
    currentUser = asUser(proId, 'Professional');
    const res = await materialize(seriesId, occurrenceDate);

    expect(res.status).toBe(422);
    expect(errorOf(res).fieldDetails?.occurrence_date.key).toBe('notInSeries');
  });

  test('rejects a date after the series end', async () => {
    currentUser = asUser(proId, 'Professional');
    const startDate = addDaysISO(MONDAY, 161);
    const created = await createSeries({
      start_date: startDate,
      end_kind: 'until',
      end_date: startDate,
    });
    expect(created.status).toBe(201);
    const boundedSeriesId = dataOf(created).series.id;

    const res = await materialize(boundedSeriesId, addDaysISO(startDate, 7));

    expect(res.status).toBe(422);
    expect(errorOf(res).fieldDetails?.occurrence_date.key).toBe('notInSeries');
    await pool.query(`DELETE FROM appointment_series WHERE id = $1`, [boundedSeriesId]);
  });

  test('cross-tenant id → 404 (never leak existence)', async () => {
    currentUser = asUser(pro3Id, 'Professional', biz2Id);
    const res = await materialize(seriesId, addDaysISO(MONDAY, 91));
    expect(res.status).toBe(404);
  });

  test('unknown id → 404', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await materialize('999999999', addDaysISO(MONDAY, 91));
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/appointments/series/:id — whole-series rule edit', () => {
  test('patches a rule field and leaves price/duration frozen', async () => {
    currentUser = asUser(proId, 'Professional');
    const created = await createSeries({ start_date: addDaysISO(MONDAY, 112) });
    expect(created.status).toBe(201);
    const before = dataOf(created).series;

    const res = await seriesReq<SeriesResult<Series>>('PUT', `/api/appointments/series/${before.id}`, { interval: 2 });
    expect(res.status).toBe(200);
    const after = dataOf(res).series;
    expect(after.interval).toBe(2);
    expect(after.price_ars).toBe(before.price_ars);
    expect(after.duration_minutes).toBe(before.duration_minutes);

    await pool.query(`DELETE FROM appointment_series WHERE id = $1`, [before.id]);
  });

  test('cross-tenant id → 404', async () => {
    currentUser = asUser(proId, 'Professional');
    const created = await createSeries({ start_date: addDaysISO(MONDAY, 119) });
    expect(created.status).toBe(201);
    const seriesId = dataOf(created).series.id;

    currentUser = asUser(pro3Id, 'Professional', biz2Id);
    const res = await seriesReq<SeriesResult<Series>>('PUT', `/api/appointments/series/${seriesId}`, { interval: 3 });
    expect(res.status).toBe(404);

    await pool.query(`DELETE FROM appointment_series WHERE id = $1`, [seriesId]);
  });
});

describe('GET /api/appointments/series/:id — read one series', () => {
  test('a granted Receptionist reads the series rule', async () => {
    currentUser = asUser(proId, 'Professional');
    const created = await createSeries({ start_date: addDaysISO(MONDAY, 133) });
    expect(created.status).toBe(201);
    const seriesId = dataOf(created).series.id;

    currentUser = asUser(recepWithGrantId, 'Receptionist');
    const res = await seriesReq<Series>('GET', `/api/appointments/series/${seriesId}`);
    expect(res.status).toBe(200);
    const data = dataOf(res);
    expect(data.id).toBe(seriesId);
    expect(data.frequency).toBe('weekly');
    expect(data.weekday).toBe('mon');

    currentUser = asUser(proId, 'Professional');
    await pool.query(`DELETE FROM appointment_series WHERE id = $1`, [seriesId]);
  });

  test('an ungranted Receptionist is denied (403)', async () => {
    currentUser = asUser(proId, 'Professional');
    const created = await createSeries({ start_date: addDaysISO(MONDAY, 147) });
    expect(created.status).toBe(201);
    const seriesId = dataOf(created).series.id;

    currentUser = asUser(recepNoGrantId, 'Receptionist');
    const res = await seriesReq<Series>('GET', `/api/appointments/series/${seriesId}`);
    expect(res.status).toBe(403);

    currentUser = asUser(proId, 'Professional');
    await pool.query(`DELETE FROM appointment_series WHERE id = $1`, [seriesId]);
  });

  test('cross-tenant id → 404 (never leak existence)', async () => {
    currentUser = asUser(proId, 'Professional');
    const created = await createSeries({ start_date: addDaysISO(MONDAY, 154) });
    expect(created.status).toBe(201);
    const seriesId = dataOf(created).series.id;

    currentUser = asUser(pro3Id, 'Professional', biz2Id);
    const res = await seriesReq<Series>('GET', `/api/appointments/series/${seriesId}`);
    expect(res.status).toBe(404);

    currentUser = asUser(proId, 'Professional');
    await pool.query(`DELETE FROM appointment_series WHERE id = $1`, [seriesId]);
  });

  test('unknown id → 404', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await seriesReq<Series>('GET', `/api/appointments/series/999999999`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/appointments/series/:id/future — this-and-future split', () => {
  test('ends the old rule the day before from_date and opens a new series on from_date', async () => {
    currentUser = asUser(proId, 'Professional');
    const created = await createSeries({ start_date: addDaysISO(MONDAY, 126) });
    expect(created.status).toBe(201);
    const seriesId = dataOf(created).series.id;

    const fromDate = addDaysISO(MONDAY, 140);
    const res = await seriesReq<SplitSeriesResult<Series>>('POST', `/api/appointments/series/${seriesId}/future`, {
      from_date: fromDate,
      patch: { interval: 2 },
    });
    expect(res.status).toBe(201);
    const data = dataOf(res);
    expect(data.ended.id).toBe(seriesId);
    expect(data.ended.status).toBe('ended');
    expect(data.ended.end_date).toBe(addDaysISO(fromDate, -1));
    expect(data.created.interval).toBe(2);
    expect(data.created.start_date).toBe(fromDate);
    expect(data.created.price_ars).toBe(data.ended.price_ars);

    await pool.query(`DELETE FROM appointment_series WHERE id = ANY($1)`, [[seriesId, data.created.id]]);
  });
});

describe('POST /api/appointments/series/:id/end', () => {
  test('ends the series and cancels a future materialized occurrence', async () => {
    currentUser = asUser(proId, 'Professional');
    const created = await createSeries({ start_date: addDaysISO(MONDAY, 98) });
    expect(created.status).toBe(201);
    const seriesId = dataOf(created).series.id;

    const occurrenceDate = addDaysISO(MONDAY, 105);
    const materialized = await materialize(seriesId, occurrenceDate);
    expect(materialized.status).toBe(200);
    const apptId = dataOf(materialized).appointment.id;

    const ended = await seriesReq<EndSeriesResult<Series>>('POST', `/api/appointments/series/${seriesId}/end`, {
      from_date: occurrenceDate,
    });
    expect(ended.status).toBe(200);
    const data = dataOf(ended);
    expect(data.ended.status).toBe('ended');
    expect(data.canceled).toContain(apptId);

    const check = await pool.query<{ state: string }>(`SELECT state FROM appointments WHERE id = $1`, [apptId]);
    expect(check.rows[0].state).toBe('canceled');

    await pool.query(`DELETE FROM appointments WHERE series_id = $1`, [seriesId]);
    await pool.query(`DELETE FROM appointment_series WHERE id = $1`, [seriesId]);
  });
});

describe('series route lifecycle: create → materialize → complete charges once', () => {
  test('completing a materialized occurrence via the transition route posts exactly one charge', async () => {
    currentUser = asUser(proId, 'Professional');
    // A past Monday (7 divides evenly, so weekday stays Monday) so the completion timing guard
    // (starts_at <= now) is satisfied without touching any other fixture's date. This series is
    // never cleaned up (see below), so it is bounded to its single occurrence (end_kind: until,
    // same date) — otherwise, being open-ended, it would keep recurring forever and pollute every
    // later date-range list test in this file.
    const pastDate = addDaysISO(MONDAY, -70);

    const created = await createSeries({
      start_date: pastDate,
      end_kind: 'until',
      end_date: pastDate,
    });
    expect(created.status).toBe(201);
    const seriesId = dataOf(created).series.id;

    const materialized = await materialize(seriesId, pastDate);
    expect(materialized.status).toBe(200);
    const appt = dataOf(materialized).appointment;
    expect(appt.state).toBe('scheduled');

    const transitioned = await seriesReq<AppointmentResponse>(
      'POST',
      `/api/appointments/${appt.id}/transition`,
      { to: 'completed' },
    );
    expect(transitioned.status).toBe(200);
    expect(dataOf(transitioned).state).toBe('completed');

    const charges = await pool.query<{ amount_ars: string }>(
      `SELECT amount_ars FROM ledger_entries WHERE appointment_id = $1 AND entry_type = 'charge'`,
      [appt.id],
    );
    expect(charges.rows).toHaveLength(1);
    expect(charges.rows[0].amount_ars).toBe(appt.price);

    // No cleanup: ledger_entries are append-only, and the charge's appointment_id FK blocks
    // deleting the appointment (and transitively, the series) — matches the convention in
    // appointments-lifecycle.test.ts's charge tests.
  });
});

describe('GET /api/appointments — virtual-aware pagination over a date range', () => {
  // A dedicated weekly-Monday window, far from every other fixture's date, spanning 5 Mondays —
  // one active series yields 5 virtual occurrences here (none materialized, none conflicting).
  const windowSeriesStart = addDaysISO(MONDAY, 294); // 294 = 42 * 7, so this Monday stays a Monday
  const windowStart = addDaysISO(windowSeriesStart, -1);
  const windowEnd = addDaysISO(windowSeriesStart, 29); // covers 5 weekly Mondays
  const realDates = [
    addDaysISO(windowSeriesStart, 1),
    addDaysISO(windowSeriesStart, 8),
    addDaysISO(windowSeriesStart, 15),
  ];
  let paginationSeriesId: string;
  const realApptIds: string[] = [];

  beforeAll(async () => {
    currentUser = asUser(proId, 'Professional');
    const created = await createSeries({ start_date: windowSeriesStart });
    expect(created.status).toBe(201);
    paginationSeriesId = dataOf(created).series.id;

    // 3 real, one-off Tuesday appointments inside the same window — never on-pattern for the
    // Monday series, so they can never collide with a virtual occurrence date.
    for (const date of realDates) {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO appointments
           (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
         VALUES ($1, $2, $3, '${date} 10:00:00 ${BA_TZ}', 30, 'scheduled', '1500.00', false)
         RETURNING id`,
        [clientId, proId, svcId],
      );
      realApptIds.push(r.rows[0].id);
    }
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM appointments WHERE id = ANY($1)`, [realApptIds]);
    await pool.query(`DELETE FROM appointment_series WHERE id = $1`, [paginationSeriesId]);
  });

  function identityOf(r: ListRow): string {
    return r.id !== null ? `real:${r.id}` : `virtual:${r.series_id}:${r.occurrence_date}`;
  }

  test('paginates the combined real+virtual set with a correct total and no duplicates across pages', async () => {
    currentUser = asUser(proId, 'Professional');
    const limit = 3;
    const expectedTotal = realDates.length + 5; // 3 real + 5 weekly virtuals

    const seen = new Map<string, number>();
    let reportedTotal: number | undefined;
    let page = 1;
    for (;;) {
      const res = await seriesReq<ListRow[]>(
        'GET',
        `/api/appointments?date_from=${windowStart}&date_to=${windowEnd}&limit=${limit}&page=${page}`,
      );
      expect(res.status).toBe(200);
      const rows = dataOf(res);
      reportedTotal = metaOf(res).total;
      expect(reportedTotal).toBe(expectedTotal);
      if (rows.length === 0) break;
      for (const r of rows) {
        const id = identityOf(r);
        seen.set(id, (seen.get(id) ?? 0) + 1);
      }
      if (page * limit >= expectedTotal) break;
      page += 1;
    }

    expect(reportedTotal).toBe(expectedTotal);
    expect(seen.size).toBe(expectedTotal);
    for (const [id, count] of seen) {
      expect(count, `identity ${id} appeared ${count} times`).toBe(1);
    }
    for (const id of realApptIds) {
      expect(seen.has(`real:${id}`)).toBe(true);
    }
  });

  test('materializing one occurrence keeps the total unchanged and is not double-listed', async () => {
    currentUser = asUser(proId, 'Professional');
    const occurrenceDate = addDaysISO(windowSeriesStart, 7); // the 2nd Monday in the window

    const materialized = await materialize(paginationSeriesId, occurrenceDate);
    expect(materialized.status).toBe(200);
    const materializedId = dataOf(materialized).appointment.id;
    realApptIds.push(materializedId); // include in afterAll cleanup

    const res = await seriesReq<ListRow[]>(
      'GET',
      `/api/appointments?date_from=${windowStart}&date_to=${windowEnd}&limit=50&page=1`,
    );
    expect(res.status).toBe(200);
    const rows = dataOf(res);
    expect(metaOf(res).total).toBe(realDates.length + 5); // unchanged: one virtual became one real row

    const matches = rows.filter(
      (r) => (r.id === materializedId) || (r.series_id === paginationSeriesId && r.occurrence_date === occurrenceDate),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe(materializedId);
  });
});

describe('GET /api/appointments — a series occurrence over an existing turno flags both sides', () => {
  // A Monday far from every other fixture (231 = 33 * 7, so it stays a Monday and matches proId's
  // only block). The series is bounded to this single occurrence so it never pollutes other windows.
  const targetMonday = addDaysISO(MONDAY, 231);
  let realId: string;
  let seriesId: string;

  beforeAll(async () => {
    currentUser = asUser(proId, 'Professional');

    const r = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, '${targetMonday} 09:00:00 ${BA_TZ}', 30, 'scheduled', '1500.00', false)
       RETURNING id`,
      [clientId, proId, svcId],
    );
    realId = r.rows[0].id;

    const created = await createSeries({
      start_date: targetMonday,
      end_kind: 'until',
      end_date: targetMonday,
    });
    expect(created.status).toBe(201);
    seriesId = dataOf(created).series.id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM appointment_series WHERE id = $1`, [seriesId]);
    await pool.query(`DELETE FROM appointments WHERE id = $1`, [realId]);
  });

  test('the real turno and the virtual occurrence both come back in_conflict', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await seriesReq<ListRow[]>(
      'GET',
      `/api/appointments?date_from=${addDaysISO(targetMonday, -1)}&date_to=${addDaysISO(targetMonday, 1)}&limit=50&page=1`,
    );
    expect(res.status).toBe(200);
    const rows = dataOf(res);

    const realRow = rows.find((r) => r.id === realId);
    expect(realRow, 'the real turno row').toBeDefined();
    expect(realRow?.in_conflict).toBe(true);

    const virtualRow = rows.find((r) => r.id === null && r.series_id === seriesId && r.occurrence_date === targetMonday);
    expect(virtualRow, 'the virtual occurrence row').toBeDefined();
    expect(virtualRow?.in_conflict).toBe(true);
  });

  test('the conflicting filter over the same window returns both', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await seriesReq<ListRow[]>(
      'GET',
      `/api/appointments?date_from=${addDaysISO(targetMonday, -1)}&date_to=${addDaysISO(targetMonday, 1)}&conflicting=true&limit=50&page=1`,
    );
    expect(res.status).toBe(200);
    const rows = dataOf(res);
    expect(rows.some((r) => r.id === realId)).toBe(true);
    expect(rows.some((r) => r.id === null && r.series_id === seriesId && r.occurrence_date === targetMonday)).toBe(true);
    expect(rows.every((r) => r.in_conflict === true)).toBe(true);
  });
});
