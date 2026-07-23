import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { insertSeries, type InsertSeriesInput } from '../src/db/series';
import { ensureOccurrenceMaterialized } from '../src/services/series-materialize';
import { withTransaction } from '../src/db/core';
import type { AppointmentRow } from '../../shared/src/ssot/query-types';
import type { AuthUser } from '../src/auth';
import { transitionAppointmentState } from '../src/db/appointments';
import { listVirtualOccurrences } from '../src/services/series-listing';
import { weekdayOf } from '../../shared/src/ssot/domain';
import type { AppointmentSeriesRow } from '../../shared/src/ssot/query-types';

// The list endpoint's virtual side: active series expand into un-materialized occurrences unioned
// with real rows. This file exercises listVirtualOccurrences directly (db-level), matching the
// series-db.test.ts / series-conflict.test.ts convention of calling the module under test rather
// than going through HTTP.

let pool: Pool;
let bizId: number;
let biz2Id: number;
let proId: number;
let pro2Id: number;
let clientId: number;
let client2Id: number;
let svcId: number;
let svc2Id: number;

// Now-relative fixture dates — never hardcode calendar dates.
function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function seedProfessionalBlock(professionalUserId: number, weekday: string, serviceId: number): Promise<void> {
  const block = await pool.query<{ id: string }>(
    `INSERT INTO schedule_blocks (professional_user_id, weekday, start_time, end_time)
     VALUES ($1, $2, '08:00', '18:00') RETURNING id`,
    [professionalUserId, weekday],
  );
  await pool.query(
    `INSERT INTO schedule_block_services (professional_user_id, schedule_block_id, service_id)
     VALUES ($1, $2, $3)`,
    [professionalUserId, block.rows[0].id, serviceId],
  );
}

function baseInput(overrides: Partial<InsertSeriesInput> = {}): InsertSeriesInput {
  return {
    client_user_id: String(clientId),
    professional_user_id: String(proId),
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
    start_date: isoDaysFromNow(1),
    end_kind: 'open',
    end_count: null,
    end_date: null,
    created_by_user_id: String(proId),
    ...overrides,
  };
}

async function materialize(series: AppointmentSeriesRow, occurrenceDate: string): Promise<AppointmentRow> {
  const staff: AuthUser = { id: proId, username: 'list_pro1', email: null, role: 'Professional', business_id: bizId, is_active: true, must_change_password: false };
  const r = await withTransaction(pool, (tx) =>
    ensureOccurrenceMaterialized(tx, series, occurrenceDate, { businessId: bizId, actor: staff }));
  return r.appointment;
}

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const biz = await pool.query<{ id: string }>(
    `INSERT INTO businesses (name, cancellation_cutoff_hours) VALUES ('Listing Biz', 0) RETURNING id`,
  );
  bizId = Number(biz.rows[0].id);
  const biz2 = await pool.query<{ id: string }>(
    `INSERT INTO businesses (name, cancellation_cutoff_hours) VALUES ('Listing Biz 2', 0) RETURNING id`,
  );
  biz2Id = Number(biz2.rows[0].id);

  const seedUser = async (username: string, role: string, businessIdArg: number): Promise<number> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO auth.users
         (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
       VALUES ($1, $2, $3, 'h', 's', $4, $5, false)
       RETURNING id`,
      [username, `${username}@listing.local`, username, role, businessIdArg],
    );
    return Number(r.rows[0].id);
  };

  proId = await seedUser('list_pro1', 'Professional', bizId);
  pro2Id = await seedUser('list_pro2', 'Professional', biz2Id);
  clientId = await seedUser('list_client1', 'Client', bizId);
  client2Id = await seedUser('list_client2', 'Client', bizId);

  const svc = await pool.query<{ id: string }>(
    `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
     VALUES ($1, 'Consulta', 30, '1500.00') RETURNING id`,
    [bizId],
  );
  svcId = Number(svc.rows[0].id);

  const svc2 = await pool.query<{ id: string }>(
    `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
     VALUES ($1, 'Consulta', 30, '1500.00') RETURNING id`,
    [biz2Id],
  );
  svc2Id = Number(svc2.rows[0].id);
});

afterAll(async () => {
  await pool.end();
});

describe('listVirtualOccurrences', () => {
  test('expands an active series with no materialized rows into virtual entries', async () => {
    const startDate = isoDaysFromNow(3);
    const weekday = weekdayOf(startDate);
    await seedProfessionalBlock(proId, weekday, svcId);
    const series = (await insertSeries(pool, baseInput({ weekday, start_date: startDate }))) as AppointmentSeriesRow;

    const windowStart = startDate;
    const windowEnd = isoDaysFromNow(3 + 21);
    const virtuals = await listVirtualOccurrences(pool, {
      businessId: bizId,
      roleScope: { kind: 'professional', userId: proId },
      windowStart,
      windowEnd,
    });

    expect(virtuals.length).toBeGreaterThan(0);
    const first = virtuals.find((v) => v.occurrence_date === startDate)!;
    expect(first).toBeDefined();
    expect(first.id).toBeNull();
    expect(first.series_id).toBe(series.id);
    expect(first.is_virtual).toBe(true);
    expect(first.state).toBe('scheduled');
    expect(first.price).toBe('1500.00');
    expect(first.duration_minutes).toBe(30);
    expect(first.client_user_id).toBe(String(clientId));
    expect(first.professional_user_id).toBe(String(proId));
    expect(first.name).toBeNull();
    expect(first.description).toBeNull();
    // 09:00 ART == 12:00Z, same calendar day, so the ISO instant still starts with the occurrence date.
    expect(first.starts_at.startsWith(startDate)).toBe(true);
    expect(first.in_conflict).toBe(false);
  });

  test('a materialized occurrence is not duplicated as a virtual', async () => {
    const startDate = isoDaysFromNow(40);
    const weekday = weekdayOf(startDate);
    await seedProfessionalBlock(proId, weekday, svcId);
    const series = (await insertSeries(pool, baseInput({ weekday, start_date: startDate }))) as AppointmentSeriesRow;
    const occurrenceDate = startDate; // first occurrence lands exactly on start_date

    const windowStart = startDate;
    const windowEnd = isoDaysFromNow(40 + 14);

    const before = await listVirtualOccurrences(pool, {
      businessId: bizId,
      roleScope: { kind: 'professional', userId: proId },
      windowStart,
      windowEnd,
    });
    expect(before.some((v) => v.series_id === series.id && v.occurrence_date === occurrenceDate)).toBe(true);

    await materialize(series, occurrenceDate);

    const after = await listVirtualOccurrences(pool, {
      businessId: bizId,
      roleScope: { kind: 'professional', userId: proId },
      windowStart,
      windowEnd,
    });
    expect(after.some((v) => v.series_id === series.id && v.occurrence_date === occurrenceDate)).toBe(false);
    // The following occurrence (still untouched) still appears.
    expect(after.some((v) => v.series_id === series.id && v.occurrence_date !== occurrenceDate)).toBe(true);
  });

  test('a canceled materialized occurrence is not re-added as a virtual', async () => {
    const startDate = isoDaysFromNow(60);
    const weekday = weekdayOf(startDate);
    await seedProfessionalBlock(proId, weekday, svcId);
    const series = (await insertSeries(pool, baseInput({ weekday, start_date: startDate }))) as AppointmentSeriesRow;
    const occurrenceDate = startDate;

    const materialized = await materialize(series, occurrenceDate);
    await transitionAppointmentState(pool, Number(materialized.id), 'canceled');

    const windowStart = startDate;
    const windowEnd = isoDaysFromNow(60 + 7);
    const virtuals = await listVirtualOccurrences(pool, {
      businessId: bizId,
      roleScope: { kind: 'professional', userId: proId },
      windowStart,
      windowEnd,
    });
    expect(virtuals.some((v) => v.series_id === series.id && v.occurrence_date === occurrenceDate)).toBe(false);
  });

  test('a client sees only their own series occurrences', async () => {
    const startDate = isoDaysFromNow(80);
    const weekday = weekdayOf(startDate);
    await seedProfessionalBlock(proId, weekday, svcId);

    const mine = (await insertSeries(pool, baseInput({ weekday, start_date: startDate, client_user_id: String(clientId) }))) as AppointmentSeriesRow;
    const other = (await insertSeries(pool, baseInput({ weekday, start_date: startDate, client_user_id: String(client2Id) }))) as AppointmentSeriesRow;

    const windowStart = startDate;
    const windowEnd = isoDaysFromNow(80 + 7);
    const virtuals = await listVirtualOccurrences(pool, {
      businessId: bizId,
      roleScope: { kind: 'client', userId: clientId },
      windowStart,
      windowEnd,
    });

    expect(virtuals.some((v) => v.series_id === mine.id)).toBe(true);
    expect(virtuals.some((v) => v.series_id === other.id)).toBe(false);
  });

  test('a series in another business never appears', async () => {
    const startDate = isoDaysFromNow(100);
    const weekday = weekdayOf(startDate);
    await seedProfessionalBlock(pro2Id, weekday, svc2Id);

    const otherBizSeries = (await insertSeries(
      pool,
      baseInput({
        weekday,
        start_date: startDate,
        professional_user_id: String(pro2Id),
        service_id: String(svc2Id),
        created_by_user_id: String(pro2Id),
      }),
    )) as AppointmentSeriesRow;

    const windowStart = startDate;
    const windowEnd = isoDaysFromNow(100 + 7);
    const virtuals = await listVirtualOccurrences(pool, {
      businessId: bizId,
      roleScope: { kind: 'all' },
      windowStart,
      windowEnd,
    });

    expect(virtuals.some((v) => v.series_id === otherBizSeries.id)).toBe(false);
  });

  test('in_conflict is true when an occurrence lands on a full-day exception (day-off)', async () => {
    const conflictDate = isoDaysFromNow(120);
    const freeDate = isoDaysFromNow(127); // one week later, same weekday, no exception
    const weekday = weekdayOf(conflictDate);
    await seedProfessionalBlock(proId, weekday, svcId);

    const series = (await insertSeries(pool, baseInput({ weekday, start_date: conflictDate }))) as AppointmentSeriesRow;

    await pool.query(
      `INSERT INTO schedule_exceptions (professional_user_id, exception_date, is_unavailable, start_time, end_time)
       VALUES ($1, $2::date, true, NULL, NULL)`,
      [proId, conflictDate],
    );

    const virtuals = await listVirtualOccurrences(pool, {
      businessId: bizId,
      roleScope: { kind: 'professional', userId: proId },
      windowStart: conflictDate,
      windowEnd: freeDate,
    });

    const onDayOff = virtuals.find((v) => v.series_id === series.id && v.occurrence_date === conflictDate);
    const onFreeDay = virtuals.find((v) => v.series_id === series.id && v.occurrence_date === freeDate);
    expect(onDayOff).toBeDefined();
    expect(onDayOff!.in_conflict).toBe(true);
    expect(onFreeDay).toBeDefined();
    expect(onFreeDay!.in_conflict).toBe(false);

    // conflicting filter narrows the result to the in-conflict occurrence only.
    const conflictingOnly = await listVirtualOccurrences(pool, {
      businessId: bizId,
      roleScope: { kind: 'professional', userId: proId },
      windowStart: conflictDate,
      windowEnd: freeDate,
      conflicting: true,
    });
    expect(conflictingOnly.some((v) => v.series_id === series.id && v.occurrence_date === conflictDate)).toBe(true);
    expect(conflictingOnly.some((v) => v.series_id === series.id && v.occurrence_date === freeDate)).toBe(false);
  });

  test('a state filter incompatible with scheduled returns no virtuals', async () => {
    const startDate = isoDaysFromNow(140);
    const weekday = weekdayOf(startDate);
    await seedProfessionalBlock(proId, weekday, svcId);
    await insertSeries(pool, baseInput({ weekday, start_date: startDate }));

    const virtuals = await listVirtualOccurrences(pool, {
      businessId: bizId,
      roleScope: { kind: 'professional', userId: proId },
      windowStart: startDate,
      windowEnd: isoDaysFromNow(140 + 7),
      state: 'completed',
    });
    expect(virtuals).toEqual([]);
  });

  test('in_conflict is true when the series resource is double-booked, even though the professional is free', async () => {
    const occurrenceDate = isoDaysFromNow(160);
    const weekday = weekdayOf(occurrenceDate);
    await seedProfessionalBlock(proId, weekday, svcId);

    const resource = await pool.query<{ id: string }>(
      `INSERT INTO resources (business_id, name) VALUES ($1, 'Sala Listing') RETURNING id`,
      [bizId],
    );
    const resourceId = Number(resource.rows[0].id);
    await pool.query(
      `INSERT INTO schedule_blocks (resource_id, weekday, start_time, end_time) VALUES ($1, $2, '08:00', '18:00')`,
      [resourceId, weekday],
    );

    const series = (await insertSeries(pool, baseInput({
      weekday,
      start_date: occurrenceDate,
      resource_id: String(resourceId),
    }))) as AppointmentSeriesRow;

    // A different professional's real booking occupies the same resource at the series' occurrence
    // time — proId (the series' own professional) has no overlapping booking of its own, so any
    // in_conflict here can only come from the resource side.
    const otherPro = await pool.query<{ id: string }>(
      `INSERT INTO auth.users
         (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
       VALUES ('list_pro3', 'list_pro3@listing.local', 'list_pro3', 'h', 's', 'Professional', $1, false)
       RETURNING id`,
      [bizId],
    );
    await pool.query(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, resource_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, $4, $5, 30, 'scheduled', '1500.00', false)`,
      [clientId, Number(otherPro.rows[0].id), resourceId, svcId, `${occurrenceDate} 09:00:00-03`],
    );

    const virtuals = await listVirtualOccurrences(pool, {
      businessId: bizId,
      roleScope: { kind: 'professional', userId: proId },
      windowStart: occurrenceDate,
      windowEnd: occurrenceDate,
    });

    const occurrence = virtuals.find((v) => v.series_id === series.id && v.occurrence_date === occurrenceDate);
    expect(occurrence).toBeDefined();
    expect(occurrence!.in_conflict).toBe(true);
  });
});
