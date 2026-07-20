import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { insertSeries, type InsertSeriesInput } from '../src/db/series';
import { getAppointmentWallClock } from '../src/db/appointments';
import { transitionAppointmentState } from '../src/db/appointments';
import { insertSessionChargeIfAbsent } from '../src/db/ledger';
import { ensureOccurrenceMaterialized } from '../src/services/series-materialize';
import { weekdayOf } from '../../shared/src/ssot/domain/availability';
import type { AppointmentSeriesRow } from '../../shared/src/ssot/query-types';

const BUSINESS_TZ = 'America/Argentina/Buenos_Aires';

let pool: Pool;
let bizId: number;
let proId: number;
let clientId: number;
let svcId: number;

function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
// The weekday MUST match START_DATE's own weekday and every occurrence date must be a whole number
// of weeks after it, or expandSeries rejects the date as off-pattern (which day-of-week that lands
// on shifts with the real calendar — deriving it keeps the test deterministic every day).
const START_DATE = isoDaysFromNow(1);
const START_WEEKDAY = weekdayOf(START_DATE);
const OCCURRENCE_DATE = isoDaysFromNow(1 + 7);

function baseInput(overrides: Partial<InsertSeriesInput> = {}): InsertSeriesInput {
  return {
    client_user_id: String(clientId),
    professional_user_id: String(proId),
    service_id: String(svcId),
    resource_id: null,
    frequency: 'weekly',
    interval: 1,
    weekday: START_WEEKDAY,
    week_of_month: null,
    day_of_month: null,
    start_time: '09:00',
    duration_minutes: 30,
    price_ars: '1500.00',
    start_date: START_DATE,
    end_kind: 'open',
    end_count: null,
    end_date: null,
    created_by_user_id: String(proId),
    ...overrides,
  };
}

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const biz = await pool.query<{ id: string }>(
    `INSERT INTO businesses (name, cancellation_cutoff_hours) VALUES ('Materialize Biz', 0) RETURNING id`,
  );
  bizId = Number(biz.rows[0].id);

  const seedUser = async (username: string, role: string): Promise<number> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO auth.users
         (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
       VALUES ($1, $2, $3, 'h', 's', $4, $5, false)
       RETURNING id`,
      [username, `${username}@materialize.local`, username, role, bizId],
    );
    return Number(r.rows[0].id);
  };

  proId = await seedUser('mat_pro1', 'Professional');
  clientId = await seedUser('mat_client1', 'Client');

  const svc = await pool.query<{ id: string }>(
    `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
     VALUES ($1, 'Consulta', 30, '1500.00') RETURNING id`,
    [bizId],
  );
  svcId = Number(svc.rows[0].id);
});

afterAll(async () => {
  await pool.end();
});

describe('ensureOccurrenceMaterialized', () => {
  test('first call materializes a scheduled row with series identity, frozen price, and correct wall-clock', async () => {
    const series = (await insertSeries(pool, baseInput())) as AppointmentSeriesRow;

    const appt = await ensureOccurrenceMaterialized(pool, series, OCCURRENCE_DATE);

    expect(appt.series_id).toBe(series.id);
    expect(appt.occurrence_date).toBe(OCCURRENCE_DATE);
    expect(appt.state).toBe('scheduled');
    expect(appt.price).toBe(series.price_ars);
    expect(appt.duration_minutes).toBe(series.duration_minutes);
    expect(appt.client_user_id).toBe(series.client_user_id);
    expect(appt.professional_user_id).toBe(series.professional_user_id);

    const wall = await getAppointmentWallClock(pool, Number(appt.id), BUSINESS_TZ);
    expect(wall).not.toBeNull();
    expect(wall!.date).toBe(OCCURRENCE_DATE);
    expect(wall!.start).toBe(series.start_time.slice(0, 5));
  });

  test('second call with the same (series, date) is idempotent — returns the same row, no duplicate', async () => {
    const series = (await insertSeries(pool, baseInput())) as AppointmentSeriesRow;
    const occurrenceDate = isoDaysFromNow(1 + 14);

    const first = await ensureOccurrenceMaterialized(pool, series, occurrenceDate);
    const second = await ensureOccurrenceMaterialized(pool, series, occurrenceDate);

    expect(second.id).toBe(first.id);

    const count = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM appointments WHERE series_id = $1 AND occurrence_date = $2`,
      [series.id, occurrenceDate],
    );
    expect(count.rows[0].n).toBe('1');
  });

  test('a concurrent race (pre-existing row inserted directly) is resolved via the unique index — no throw, same row returned', async () => {
    const series = (await insertSeries(pool, baseInput())) as AppointmentSeriesRow;
    const occurrenceDate = isoDaysFromNow(1 + 21);

    // Simulate another materializer winning the race: insert the row directly first.
    const raw = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes,
          state, price, override_conflict, series_id, occurrence_date)
       VALUES ($1, $2, $3, $4, 30, 'scheduled', '1500.00', false, $5, $6::date)
       RETURNING id`,
      [clientId, proId, svcId, `${occurrenceDate} 09:00:00`, series.id, occurrenceDate],
    );
    const winnerId = raw.rows[0].id;

    const result = await ensureOccurrenceMaterialized(pool, series, occurrenceDate);
    expect(result.id).toBe(winnerId);

    const count = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM appointments WHERE series_id = $1 AND occurrence_date = $2`,
      [series.id, occurrenceDate],
    );
    expect(count.rows[0].n).toBe('1');
  });

  test('materialized row flows through the normal completion lifecycle unchanged — posts exactly one ledger charge', async () => {
    const series = (await insertSeries(pool, baseInput())) as AppointmentSeriesRow;
    const occurrenceDate = isoDaysFromNow(1 + 28);

    const appt = await ensureOccurrenceMaterialized(pool, series, occurrenceDate);
    const id = Number(appt.id);

    const completed = await transitionAppointmentState(pool, id, 'completed');
    expect(completed!.state).toBe('completed');

    const chargeId = await insertSessionChargeIfAbsent(pool, {
      clientUserId: appt.client_user_id,
      appointmentId: id,
      amountArs: appt.price,
      actorUserId: proId,
    });
    expect(chargeId).not.toBeNull();

    const charges = await pool.query<{ amount_ars: string }>(
      `SELECT amount_ars FROM ledger_entries WHERE appointment_id = $1 AND entry_type = 'charge'`,
      [id],
    );
    expect(charges.rows).toHaveLength(1);
    expect(charges.rows[0].amount_ars).toBe(series.price_ars);
  });
});
