import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import {
  insertSeries,
  getActiveSeriesForOwner,
  getMaterializedOverrides,
  endSeriesAt,
  updateSeriesRule,
  type InsertSeriesInput,
} from '../src/db/series';

let pool: Pool;
let biz1Id: number;
let biz2Id: number;
let pro1Id: number;
let pro2Id: number;
let clientId: number;
let svcId: number;

// Compute dates relative to now (mandatory — never hardcode calendar dates).
function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const START = isoDaysFromNow(1);
const WINDOW_START = isoDaysFromNow(0);
const WINDOW_END = isoDaysFromNow(90);

function baseInput(overrides: Partial<InsertSeriesInput> = {}): InsertSeriesInput {
  return {
    client_user_id: String(clientId),
    professional_user_id: String(pro1Id),
    service_id: String(svcId),
    resource_id: null,
    frequency: 'weekly',
    interval: 1,
    weekday: 'mon',
    week_of_month: null,
    day_of_month: null,
    start_time: '09:00',
    duration_minutes: 30,
    price_ars: '1500.00',
    start_date: START,
    end_kind: 'open',
    end_count: null,
    end_date: null,
    created_by_user_id: String(pro1Id),
    ...overrides,
  };
}

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const biz1 = await pool.query<{ id: string }>(
    `INSERT INTO businesses (name, cancellation_cutoff_hours) VALUES ('Series Biz 1', 0) RETURNING id`,
  );
  biz1Id = Number(biz1.rows[0].id);
  const biz2 = await pool.query<{ id: string }>(
    `INSERT INTO businesses (name, cancellation_cutoff_hours) VALUES ('Series Biz 2', 0) RETURNING id`,
  );
  biz2Id = Number(biz2.rows[0].id);

  const seedUser = async (username: string, role: string, bizId: number): Promise<number> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO auth.users
         (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
       VALUES ($1, $2, $3, 'h', 's', $4, $5, false)
       RETURNING id`,
      [username, `${username}@series.local`, username, role, bizId],
    );
    return Number(r.rows[0].id);
  };

  pro1Id = await seedUser('series_pro1', 'Professional', biz1Id);
  pro2Id = await seedUser('series_pro2', 'Professional', biz2Id);
  clientId = await seedUser('series_client1', 'Client', biz1Id);

  const svc = await pool.query<{ id: string }>(
    `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
     VALUES ($1, 'Consulta', 30, '1500.00') RETURNING id`,
    [biz1Id],
  );
  svcId = Number(svc.rows[0].id);
});

afterAll(async () => {
  await pool.end();
});

describe('insertSeries', () => {
  test('inserts and round-trips values, with the wire-honest string/number split', async () => {
    const row = await insertSeries(pool, baseInput());
    expect(row).not.toBeNull();
    // BIGINT columns arrive as strings.
    expect(typeof row!.id).toBe('string');
    expect(row!.client_user_id).toBe(String(clientId));
    expect(row!.professional_user_id).toBe(String(pro1Id));
    expect(row!.service_id).toBe(String(svcId));
    expect(row!.resource_id).toBeNull();
    expect(row!.created_by_user_id).toBe(String(pro1Id));
    // NUMERIC arrives as a string.
    expect(row!.price_ars).toBe('1500.00');
    // INTEGER/SMALLINT arrive as numbers (pg's own default parsing — same split AppointmentRow
    // already relies on for duration_minutes).
    expect(typeof row!.interval).toBe('number');
    expect(row!.interval).toBe(1);
    expect(typeof row!.duration_minutes).toBe('number');
    expect(row!.duration_minutes).toBe(30);
    expect(row!.week_of_month).toBeNull();
    expect(row!.day_of_month).toBeNull();
    expect(row!.end_count).toBeNull();
    // Other scalar fields round-trip verbatim.
    expect(row!.frequency).toBe('weekly');
    expect(row!.weekday).toBe('mon');
    expect(row!.start_date).toBe(START);
    expect(row!.end_kind).toBe('open');
    expect(row!.end_date).toBeNull();
    expect(row!.status).toBe('active');
    expect(row!.start_time.startsWith('09:00')).toBe(true);
  });
});

describe('getActiveSeriesForOwner', () => {
  test('returns a series overlapping the window', async () => {
    const inserted = await insertSeries(pool, baseInput());
    const rows = await getActiveSeriesForOwner(pool, String(biz1Id), String(pro1Id), WINDOW_START, WINDOW_END);
    expect(rows.some((r) => r.id === inserted!.id)).toBe(true);
  });

  test('excludes an ended series', async () => {
    const inserted = await insertSeries(pool, baseInput());
    await endSeriesAt(pool, inserted!.id, isoDaysFromNow(5));
    const rows = await getActiveSeriesForOwner(pool, String(biz1Id), String(pro1Id), WINDOW_START, WINDOW_END);
    expect(rows.some((r) => r.id === inserted!.id)).toBe(false);
  });

  test('excludes a series owned by a professional in a different business', async () => {
    const otherBizInput = baseInput({ professional_user_id: String(pro2Id), created_by_user_id: String(pro2Id) });
    const inserted = await insertSeries(pool, otherBizInput);
    // Scoped to biz1: pro2's series (biz2) must not appear even though we query pro2's own id —
    // exercised by scoping the *business*, not just the owner id, matching the b1-admin/b2-pro mismatch.
    const rows = await getActiveSeriesForOwner(pool, String(biz1Id), String(pro2Id), WINDOW_START, WINDOW_END);
    expect(rows.some((r) => r.id === inserted!.id)).toBe(false);
    // Sanity: the same series IS visible when scoped to its real business (biz2), or to super-admin (null).
    const ownBizRows = await getActiveSeriesForOwner(pool, String(biz2Id), String(pro2Id), WINDOW_START, WINDOW_END);
    expect(ownBizRows.some((r) => r.id === inserted!.id)).toBe(true);
    const allTenantRows = await getActiveSeriesForOwner(pool, null, String(pro2Id), WINDOW_START, WINDOW_END);
    expect(allTenantRows.some((r) => r.id === inserted!.id)).toBe(true);
  });

  test('a count-kind series is permissively included regardless of window', async () => {
    const inserted = await insertSeries(pool, baseInput({ end_kind: 'count', end_count: 3 }));
    const rows = await getActiveSeriesForOwner(pool, String(biz1Id), String(pro1Id), WINDOW_START, WINDOW_END);
    expect(rows.some((r) => r.id === inserted!.id)).toBe(true);
  });

  test('a series starting after the window is excluded', async () => {
    const inserted = await insertSeries(pool, baseInput({ start_date: isoDaysFromNow(200) }));
    const rows = await getActiveSeriesForOwner(pool, String(biz1Id), String(pro1Id), WINDOW_START, WINDOW_END);
    expect(rows.some((r) => r.id === inserted!.id)).toBe(false);
  });
});

describe('getMaterializedOverrides', () => {
  test('returns [] for empty seriesIds without querying', async () => {
    const rows = await getMaterializedOverrides(pool, [], WINDOW_START, WINDOW_END);
    expect(rows).toEqual([]);
  });

  test('returns override rows for given series ids within the window', async () => {
    const series = await insertSeries(pool, baseInput());
    const occurrenceDate = isoDaysFromNow(7);
    const appt = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes,
          state, price, override_conflict, series_id, occurrence_date)
       VALUES ($1, $2, $3, $4, 30, 'scheduled', '1500.00', false, $5, $6::date)
       RETURNING id`,
      [clientId, pro1Id, svcId, `${occurrenceDate} 09:00:00`, series!.id, occurrenceDate],
    );

    const rows = await getMaterializedOverrides(pool, [series!.id], WINDOW_START, WINDOW_END);
    expect(rows).toHaveLength(1);
    expect(rows[0].series_id).toBe(series!.id);
    expect(rows[0].occurrence_date).toBe(occurrenceDate);
    expect(rows[0].state).toBe('scheduled');
    expect(typeof rows[0].duration_minutes).toBe('string');
    expect(rows[0].duration_minutes).toBe('30');
    expect(Number(appt.rows[0].id)).toBeGreaterThan(0);
  });
});

describe('endSeriesAt', () => {
  test('flips status to ended and sets end_kind/end_date', async () => {
    const inserted = await insertSeries(pool, baseInput());
    const endDate = isoDaysFromNow(30);
    await endSeriesAt(pool, inserted!.id, endDate);

    const check = await pool.query<{ status: string; end_kind: string; end_date: string }>(
      `SELECT status, end_kind, end_date FROM appointment_series WHERE id = $1`,
      [inserted!.id],
    );
    expect(check.rows[0].status).toBe('ended');
    expect(check.rows[0].end_kind).toBe('until');
    expect(check.rows[0].end_date).toBe(endDate);
  });

  // A count-bounded series (the UI's default "Repetir" shape) still carries end_count when ended;
  // the appointment_series_end_shape CHECK requires it NULL once end_kind flips to 'until', so
  // endSeriesAt must clear it explicitly or the UPDATE itself violates the constraint.
  test('clears end_count when ending a series that was end_kind=count', async () => {
    const inserted = await insertSeries(pool, baseInput({ end_kind: 'count', end_count: 5 }));
    const endDate = isoDaysFromNow(30);
    await endSeriesAt(pool, inserted!.id, endDate);

    const check = await pool.query<{ end_kind: string; end_count: number | null }>(
      `SELECT end_kind, end_count FROM appointment_series WHERE id = $1`,
      [inserted!.id],
    );
    expect(check.rows[0].end_kind).toBe('until');
    expect(check.rows[0].end_count).toBeNull();
  });
});

describe('updateSeriesRule', () => {
  test('patches only the provided fields and returns the updated row', async () => {
    const inserted = await insertSeries(pool, baseInput());
    const updated = await updateSeriesRule(pool, inserted!.id, { price_ars: '2000.00', duration_minutes: 45 });
    expect(updated).not.toBeNull();
    expect(updated!.price_ars).toBe('2000.00');
    expect(updated!.duration_minutes).toBe(45);
    // Untouched fields survive.
    expect(updated!.frequency).toBe('weekly');
    expect(updated!.weekday).toBe('mon');
    expect(updated!.client_user_id).toBe(String(clientId));
  });
});
