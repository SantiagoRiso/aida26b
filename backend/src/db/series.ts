import { query, queryOne } from './core';
import type { Queryable, SqlParam } from './core';
import { grantedProfessionalScope } from './grants';
import type { AppointmentSeriesInsert, AppointmentSeriesRow } from '../../../shared/src/ssot/query-types';
import { ACTIVE_SERIES_STATUS, ENDED_SERIES_STATUS, UNTIL_END_KIND } from '../../../shared/src/ssot/domain/recurrence';

// appointment_series carries no business_id column; business is derived via the owning
// professional, exactly as appointments.ts scopes appointments through auth.users.

export type InsertSeriesInput = AppointmentSeriesInsert;

export function insertSeries(db: Queryable, input: InsertSeriesInput): Promise<AppointmentSeriesRow | null> {
  return queryOne<AppointmentSeriesRow>(
    db,
    `INSERT INTO appointment_series
       (client_user_id, professional_user_id, service_id, resource_id,
        frequency, "interval", weekday, week_of_month, day_of_month,
        start_time, duration_minutes, price_ars,
        start_date, end_kind, end_count, end_date, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING *`,
    [
      input.client_user_id, input.professional_user_id, input.service_id, input.resource_id,
      input.frequency, input.interval, input.weekday, input.week_of_month, input.day_of_month,
      input.start_time, input.duration_minutes, input.price_ars,
      input.start_date, input.end_kind, input.end_count, input.end_date, input.created_by_user_id,
    ],
  );
}

// Active series for one professional owner whose span overlaps [windowStart, windowEnd].
// businessId null = super-admin (all tenants), mirroring buildBusinessScope's null-business path —
// the join is still made so the WHERE fragment can be added conditionally without a second query
// shape. 'count' series are permissively included (their true end can't be bound in SQL — expansion
// trims to end_count); 'until' series are bound by end_date, 'open' series never excluded by span.
export function getActiveSeriesForOwner(
  db: Queryable,
  businessId: string | null,
  professionalUserId: string,
  windowStart: string,
  windowEnd: string,
): Promise<AppointmentSeriesRow[]> {
  const params: SqlParam[] = [professionalUserId, windowEnd, windowStart, ACTIVE_SERIES_STATUS];
  let businessFilter = '';
  if (businessId !== null) {
    params.push(businessId);
    businessFilter = `AND u.business_id = $${params.length}`;
  }
  return query<AppointmentSeriesRow>(
    db,
    `SELECT s.*
       FROM appointment_series s
       JOIN auth.users u ON u.id = s.professional_user_id
      WHERE s.professional_user_id = $1
        AND s.status = $4
        AND s.start_date <= $2
        AND (s.end_kind IN ('open', 'count') OR s.end_date >= $3)
        ${businessFilter}`,
    params,
  );
}

// Same as getActiveSeriesForOwner but keyed by resource_id — a series carrying a resource books
// that resource for every occurrence, so resource-side conflict checking needs the same span/status
// filter. Business scoping still goes through the professional owner (a series always has one; a
// resource itself carries no business_id path here).
export function getActiveSeriesForResource(
  db: Queryable,
  businessId: string | null,
  resourceId: string,
  windowStart: string,
  windowEnd: string,
): Promise<AppointmentSeriesRow[]> {
  const params: SqlParam[] = [resourceId, windowEnd, windowStart, ACTIVE_SERIES_STATUS];
  let businessFilter = '';
  if (businessId !== null) {
    params.push(businessId);
    businessFilter = `AND u.business_id = $${params.length}`;
  }
  return query<AppointmentSeriesRow>(
    db,
    `SELECT s.*
       FROM appointment_series s
       JOIN auth.users u ON u.id = s.professional_user_id
      WHERE s.resource_id = $1
        AND s.status = $4
        AND s.start_date <= $2
        AND (s.end_kind IN ('open', 'count') OR s.end_date >= $3)
        ${businessFilter}`,
    params,
  );
}

// Same span/status filter as getActiveSeriesForOwner but keyed by client — feeds the list
// endpoint's Client-role scope (a client sees only their own series' virtual occurrences).
export function getActiveSeriesForClient(
  db: Queryable,
  businessId: string | null,
  clientUserId: string,
  windowStart: string,
  windowEnd: string,
): Promise<AppointmentSeriesRow[]> {
  const params: SqlParam[] = [clientUserId, windowEnd, windowStart, ACTIVE_SERIES_STATUS];
  let businessFilter = '';
  if (businessId !== null) {
    params.push(businessId);
    businessFilter = `AND u.business_id = $${params.length}`;
  }
  return query<AppointmentSeriesRow>(
    db,
    `SELECT s.*
       FROM appointment_series s
       JOIN auth.users u ON u.id = s.professional_user_id
      WHERE s.client_user_id = $1
        AND s.status = $4
        AND s.start_date <= $2
        AND (s.end_kind IN ('open', 'count') OR s.end_date >= $3)
        ${businessFilter}`,
    params,
  );
}

// Every active series owned by any professional in the business — the list endpoint's Admin
// (no owner filter) scope. businessId is never null here: unlike getActiveSeriesForOwner's
// super-admin path, "all series business-wide" is meaningless without a business to bound it.
export function getActiveSeriesForBusiness(
  db: Queryable,
  businessId: string,
  windowStart: string,
  windowEnd: string,
): Promise<AppointmentSeriesRow[]> {
  return query<AppointmentSeriesRow>(
    db,
    `SELECT s.*
       FROM appointment_series s
       JOIN auth.users u ON u.id = s.professional_user_id
      WHERE u.business_id = $1
        AND s.status = $4
        AND s.start_date <= $2
        AND (s.end_kind IN ('open', 'count') OR s.end_date >= $3)`,
    [businessId, windowEnd, windowStart, ACTIVE_SERIES_STATUS],
  );
}

// Active series owned by professionals who granted a calendar to this receptionist — the list
// endpoint's Receptionist scope. Mirrors listAppointments' grantedProfessionalScope predicate so a
// receptionist's virtual occurrences never widen past their real-row visibility.
export function getActiveSeriesForGrantee(
  db: Queryable,
  businessId: string,
  granteeUserId: string,
  windowStart: string,
  windowEnd: string,
): Promise<AppointmentSeriesRow[]> {
  return query<AppointmentSeriesRow>(
    db,
    `SELECT s.*
       FROM appointment_series s
       JOIN auth.users u ON u.id = s.professional_user_id
      WHERE u.business_id = $1
        AND ${grantedProfessionalScope('s.professional_user_id', '$2')}
        AND s.status = $5
        AND s.start_date <= $3
        AND (s.end_kind IN ('open', 'count') OR s.end_date >= $4)`,
    [businessId, granteeUserId, windowEnd, windowStart, ACTIVE_SERIES_STATUS],
  );
}

// Materialized occurrence rows (ordinary appointments carrying series_id/occurrence_date) for the
// given series within a date window — what the expansion engine dedupes virtual occurrences
// against. duration_minutes is cast to text: appointments.duration_minutes is INTEGER (arrives as
// a JS number by default), but this projection's contract is string-typed like the rest of the
// series wire vocabulary, so the cast is explicit here rather than relying on driver behavior.
export async function getMaterializedOverrides(
  db: Queryable,
  seriesIds: string[],
  windowStart: string,
  windowEnd: string,
): Promise<{ series_id: string; occurrence_date: string; state: string; starts_at: string; duration_minutes: string }[]> {
  if (seriesIds.length === 0) return [];
  return query(
    db,
    `SELECT series_id, occurrence_date, state, starts_at, duration_minutes::text AS duration_minutes
       FROM appointments
      WHERE series_id = ANY($1)
        AND occurrence_date >= $2 AND occurrence_date <= $3`,
    [seriesIds, windowStart, windowEnd],
  );
}

// Null when absent or cross-tenant — both surface as 404 to hide existence, same contract as
// loadAppointment.
export function getSeriesById(db: Queryable, id: number, businessId: number): Promise<AppointmentSeriesRow | null> {
  return queryOne<AppointmentSeriesRow>(
    db,
    `SELECT s.*
       FROM appointment_series s
       JOIN auth.users u ON u.id = s.professional_user_id
      WHERE s.id = $1 AND u.business_id = $2`,
    [id, businessId],
  );
}

// Ends a series as of endDate: no further occurrences generate past it. status flips to 'ended'
// (an ended series is a closed workflow state, not just a bounded one) alongside the until-shape.
// end_count must be cleared too — a series ended while still end_kind='count' (the common case)
// would otherwise leave end_count set alongside the new end_date and violate
// appointment_series_end_shape (until requires end_count IS NULL).
export async function endSeriesAt(db: Queryable, seriesId: string, endDate: string): Promise<void> {
  await query(
    db,
    `UPDATE appointment_series
        SET end_kind = $2, end_date = $3, end_count = NULL, status = $4, updated_at = now()
      WHERE id = $1`,
    [seriesId, UNTIL_END_KIND, endDate, ENDED_SERIES_STATUS],
  );
}

// Caller guarantees at least one field is present. `interval` is quoted — it's a reserved word.
export function updateSeriesRule(
  db: Queryable,
  seriesId: string,
  patch: Partial<InsertSeriesInput>,
): Promise<AppointmentSeriesRow | null> {
  const set: string[] = [];
  const params: SqlParam[] = [];
  let p = 1;
  const add = (column: string, value: SqlParam | undefined) => {
    if (value === undefined) return;
    set.push(`"${column}" = $${p++}`);
    params.push(value);
  };
  add('client_user_id', patch.client_user_id);
  add('professional_user_id', patch.professional_user_id);
  add('service_id', patch.service_id);
  add('resource_id', patch.resource_id);
  add('frequency', patch.frequency);
  add('interval', patch.interval);
  add('weekday', patch.weekday);
  add('week_of_month', patch.week_of_month);
  add('day_of_month', patch.day_of_month);
  add('start_time', patch.start_time);
  add('duration_minutes', patch.duration_minutes);
  add('price_ars', patch.price_ars);
  add('start_date', patch.start_date);
  add('end_kind', patch.end_kind);
  add('end_count', patch.end_count);
  add('end_date', patch.end_date);
  add('created_by_user_id', patch.created_by_user_id);
  set.push('updated_at = now()');
  params.push(seriesId);
  return queryOne<AppointmentSeriesRow>(
    db,
    `UPDATE appointment_series SET ${set.join(', ')} WHERE id = $${p} RETURNING *`,
    params,
  );
}

// Stops a series from fromDate onward: virtual occurrences already won't generate past
// endSeriesAt's end_date, but already-materialized rows are ordinary appointments and need their
// own cancellation. DELETE withheld — cancel, never delete, same invariant as every other
// appointment mutation.
export function cancelFutureOccurrences(db: Queryable, seriesId: string, fromDate: string): Promise<{ id: string }[]> {
  return query<{ id: string }>(
    db,
    `UPDATE appointments
        SET state = 'canceled'
      WHERE series_id = $1 AND occurrence_date >= $2 AND state IN ('requested', 'scheduled')
      RETURNING id`,
    [seriesId, fromDate],
  );
}
