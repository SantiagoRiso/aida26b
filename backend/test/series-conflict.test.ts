import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { recheckConflictsInTx, loadOwnerState } from '../src/services/scheduling';
import { insertSeries, type InsertSeriesInput } from '../src/db/series';
import { weekdayOf } from '../../shared/src/ssot/domain';

// Recurring occurrences are virtual (never stored) until touched: this proves the conflict
// aggregator and availability calculator see an active series' pattern as occupied time, and that
// a materialized override (the real appointments row) supersedes the virtual occurrence.

let pool: Pool;
let bizId: number;
let proId: number;
let clientId: number;
let serviceId: number;

// Now-relative fixture dates — never hardcode calendar dates.
function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } finally {
    client.release();
  }
}

function baseSeriesInput(overrides: Partial<InsertSeriesInput> = {}): InsertSeriesInput {
  return {
    client_user_id: String(clientId),
    professional_user_id: String(proId),
    service_id: String(serviceId),
    resource_id: null,
    frequency: 'weekly',
    interval: 1,
    weekday: null,
    week_of_month: null,
    day_of_month: null,
    start_time: '09:00',
    duration_minutes: 30,
    price_ars: '1000.00',
    start_date: '',
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
    `INSERT INTO businesses (name, cancellation_cutoff_hours) VALUES ('Series Conflict Biz', 0) RETURNING id`,
  );
  bizId = Number(biz.rows[0].id);

  const pro = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ('sc_pro', 'sc_pro@test.local', 'Dr. Serie', 'h', 's', 'Professional', $1, false) RETURNING id`,
    [bizId],
  );
  proId = Number(pro.rows[0].id);

  const client = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ('sc_client', 'sc_client@test.local', 'Cli Serie', 'h', 's', 'Client', $1, false) RETURNING id`,
    [bizId],
  );
  clientId = Number(client.rows[0].id);

  const svc = await pool.query<{ id: string }>(
    `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
     VALUES ($1, 'Consulta', 30, '1000.00') RETURNING id`,
    [bizId],
  );
  serviceId = Number(svc.rows[0].id);
});

afterAll(async () => {
  await pool.end();
});

// Sets up a professional schedule_block (09:00-12:00) + block-service link for `weekday`, so the
// grid the aggregator/availability compares against actually offers the series' slot.
async function seedProfessionalBlock(weekday: string): Promise<void> {
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

describe('active series occupy the professional grid as conflicts', () => {
  const occurrenceDate = isoDaysFromNow(14);
  const weekday = weekdayOf(occurrenceDate);
  let seriesId: string;

  beforeAll(async () => {
    await seedProfessionalBlock(weekday);
    const series = await insertSeries(
      pool,
      baseSeriesInput({ weekday, start_date: occurrenceDate }),
    );
    seriesId = series!.id;
  });

  test('a conflict check at the series time returns professional_overlap and requires override', async () => {
    const verdict = await withTx((c) =>
      recheckConflictsInTx(c, {
        businessId: bizId,
        professionalUserId: proId,
        date: occurrenceDate,
        start: '09:00',
        durationMinutes: 30,
        serviceId,
        callerIsStaff: true,
      }),
    );
    expect(verdict.can_save).toBe(false);
    expect(verdict.requires_override).toBe(true);
    expect(verdict.conflicts.some((c) => c.type === 'professional_overlap')).toBe(true);
  });

  test('canceling the materialized override for (series, date) frees the slot again', async () => {
    await pool.query(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes,
          state, price, override_conflict, series_id, occurrence_date)
       VALUES ($1, $2, $3, $4, 30, 'canceled', '1000.00', false, $5, $6::date)`,
      [clientId, proId, serviceId, `${occurrenceDate} 09:00:00-03`, seriesId, occurrenceDate],
    );

    const verdict = await withTx((c) =>
      recheckConflictsInTx(c, {
        businessId: bizId,
        professionalUserId: proId,
        date: occurrenceDate,
        start: '09:00',
        durationMinutes: 30,
        serviceId,
        callerIsStaff: true,
      }),
    );
    expect(verdict.can_save).toBe(true);
    expect(verdict.conflicts.some((c) => c.type === 'professional_overlap')).toBe(false);
  });

  test('moving a materialized override to a new time frees the pattern slot but occupies the new one', async () => {
    // A later occurrence of the same weekly series (no override touches it yet).
    const movedDate = isoDaysFromNow(21);
    await pool.query(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes,
          state, price, override_conflict, series_id, occurrence_date)
       VALUES ($1, $2, $3, $4, 30, 'scheduled', '1000.00', false, $5, $6::date)`,
      [clientId, proId, serviceId, `${movedDate} 10:00:00-03`, seriesId, movedDate],
    );

    const patternSlot = await withTx((c) =>
      recheckConflictsInTx(c, {
        businessId: bizId,
        professionalUserId: proId,
        date: movedDate,
        start: '09:00',
        durationMinutes: 30,
        serviceId,
        callerIsStaff: true,
      }),
    );
    expect(patternSlot.can_save).toBe(true);
    expect(patternSlot.conflicts.some((c) => c.type === 'professional_overlap')).toBe(false);

    const newSlot = await withTx((c) =>
      recheckConflictsInTx(c, {
        businessId: bizId,
        professionalUserId: proId,
        date: movedDate,
        start: '10:00',
        durationMinutes: 30,
        serviceId,
        callerIsStaff: true,
      }),
    );
    expect(newSlot.can_save).toBe(false);
    expect(newSlot.conflicts.some((c) => c.type === 'professional_overlap')).toBe(true);
  });

  test('loadOwnerState(...).freeSlots excludes an untouched recurring occurrence', async () => {
    // A third, still-untouched occurrence of the same series.
    const freshDate = isoDaysFromNow(28);
    const state = await loadOwnerState(pool, bizId, { kind: 'professional', id: proId }, freshDate, { serviceId });
    expect(state).not.toBeNull();
    expect(state!.freeSlots.find((s) => s.start === '09:00' && s.end === '09:30')).toBeUndefined();
    // The rest of the grid (09:30-12:00) stays free.
    expect(state!.freeSlots.find((s) => s.start === '09:30' && s.end === '10:00')).toBeTruthy();
  });
});

describe('a series carrying a resource occupies the resource grid too', () => {
  // A dedicated professional keeps this describe block independent of the first one's series
  // (whose own weekly pattern would otherwise coincidentally recur on the same weekday here).
  let pro2Id: number;
  let resourceId: number;

  test('a conflict check on that resource at the occurrence time yields resource_overlap', async () => {
    const occurrenceDate = isoDaysFromNow(35);
    const weekday = weekdayOf(occurrenceDate);

    const pro2 = await pool.query<{ id: string }>(
      `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
       VALUES ('sc_pro2', 'sc_pro2@test.local', 'Dr. Sala', 'h', 's', 'Professional', $1, false) RETURNING id`,
      [bizId],
    );
    pro2Id = Number(pro2.rows[0].id);

    const resource = await pool.query<{ id: string }>(
      `INSERT INTO resources (business_id, name) VALUES ($1, 'Sala Serie') RETURNING id`,
      [bizId],
    );
    resourceId = Number(resource.rows[0].id);
    await pool.query(
      `INSERT INTO schedule_blocks (resource_id, weekday, start_time, end_time)
       VALUES ($1, $2, '09:00', '12:00')`,
      [resourceId, weekday],
    );
    const proBlock = await pool.query<{ id: string }>(
      `INSERT INTO schedule_blocks (professional_user_id, weekday, start_time, end_time)
       VALUES ($1, $2, '09:00', '12:00') RETURNING id`,
      [pro2Id, weekday],
    );
    await pool.query(
      `INSERT INTO schedule_block_services (professional_user_id, schedule_block_id, service_id)
       VALUES ($1, $2, $3)`,
      [pro2Id, proBlock.rows[0].id, serviceId],
    );

    await insertSeries(
      pool,
      baseSeriesInput({
        professional_user_id: String(pro2Id),
        created_by_user_id: String(pro2Id),
        weekday,
        start_date: occurrenceDate,
        resource_id: String(resourceId),
      }),
    );

    const verdict = await withTx((c) =>
      recheckConflictsInTx(c, {
        businessId: bizId,
        professionalUserId: pro2Id,
        resourceId,
        date: occurrenceDate,
        start: '09:00',
        durationMinutes: 30,
        serviceId,
        callerIsStaff: true,
      }),
    );
    expect(verdict.can_save).toBe(false);
    expect(verdict.conflicts.some((c) => c.type === 'resource_overlap')).toBe(true);
  });
});
