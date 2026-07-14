import { query, queryOne } from './core';
import type { Queryable, SqlParam } from './core';
import { OPEN_APPOINTMENT_STATES } from '../../../shared/src/ssot/domain';
import type {
  ProfessionalOwnerRow,
  ResourceOwnerRow,
  ScheduleExceptionRow,
  BusinessClosureRow,
  BookedAppointmentRow,
} from '../../../shared/src/ssot/query-types';

// SQL list literal built from the shared open-states const (code-owned values, not user input).
const OPEN_STATES_SQL = OPEN_APPOINTMENT_STATES.map((s) => `'${s}'`).join(', ');

// Only open, future turnos not already acknowledged by staff are conflict-eligible. Shared by the
// stored in_conflict flag and the warn-first preview count so the two can never disagree.
const CONFLICT_ELIGIBLE_SQL = `a.state IN (${OPEN_STATES_SQL})
    AND a.starts_at >= now()
    AND a.conflict_ignored = false`;

// End-exclusive wall-clock overlap between the turno and a [start, end) window. start/end are SQL
// expressions (column refs or casted placeholders) so both conflict sites share one definition.
function wallClockOverlapSql(tzParam: string, startExpr: string, endExpr: string): string {
  return `((a.starts_at AT TIME ZONE ${tzParam})::time < ${endExpr}
               AND (a.ends_at   AT TIME ZONE ${tzParam})::time > ${startExpr})`;
}

// A schedule_exceptions row's shape, independent of which owner column filters it (per-owner
// exception lookup vs. the business-wide closure overlay share this projection).
const EXCEPTION_PROJECTION = `is_unavailable,
            to_char(start_time, 'HH24:MI') AS start_time,
            to_char(end_time,   'HH24:MI') AS end_time,
            granularity_minutes`;

// A business closure row's shape, shared by insert/update/list — the closure CRUD handlers never
// touch owned (professional/resource) exception rows, only business_id IS NOT NULL ones.
const CLOSURE_PROJECTION = `id,
               to_char(exception_date, 'YYYY-MM-DD') AS exception_date,
               to_char(start_time, 'HH24:MI') AS start_time,
               to_char(end_time,   'HH24:MI') AS end_time,
               reason`;

// The owner column is code-controlled ('professional_user_id' | 'resource_id'), never user input,
// so interpolating it into these statements is injection-safe.

export function getProfessionalOwner(db: Queryable, id: number): Promise<ProfessionalOwnerRow | null> {
  return queryOne<ProfessionalOwnerRow>(
    db,
    `SELECT display_name, business_id FROM auth.users
      WHERE id = $1 AND role = 'Professional' AND is_active = true`,
    [id],
  );
}

export function getResourceOwner(db: Queryable, id: number): Promise<ResourceOwnerRow | null> {
  return queryOne<ResourceOwnerRow>(
    db,
    `SELECT name, business_id FROM resources WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
}

export async function resourceExistsInBusiness(db: Queryable, resourceId: number, businessId: number): Promise<boolean> {
  const rows = await query(
    db,
    `SELECT id FROM resources WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`,
    [resourceId, businessId],
  );
  return rows.length > 0;
}

// Blocks for a professional on a weekday that offer the given service, each tiled at that service's
// effective duration inside the block (per-block override else the service default). Ordered by start.
export function getScheduleBlocksForService(
  db: Queryable,
  professionalUserId: number,
  serviceId: number,
  weekday: string,
): Promise<{ start: string; end: string; slot_minutes: number }[]> {
  return query<{ start: string; end: string; slot_minutes: number }>(
    db,
    `SELECT to_char(sb.start_time, 'HH24:MI') AS start,
            to_char(sb.end_time,   'HH24:MI') AS "end",
            COALESCE(sbs.duration_minutes, s.default_duration_minutes) AS slot_minutes
       FROM schedule_blocks sb
       JOIN schedule_block_services sbs
         ON sbs.schedule_block_id = sb.id AND sbs.service_id = $2
       JOIN services s ON s.id = $2
      WHERE sb.professional_user_id = $1 AND sb.weekday = $3
      ORDER BY sb.start_time`,
    [professionalUserId, serviceId, weekday],
  );
}

// Open working windows for a professional on a weekday, independent of any service — the raw
// schedule_blocks. Feeds service-agnostic availability (the staff calendar's shading/lattice),
// where getScheduleBlocksForService (which needs a chosen service) does not apply.
export function getProfessionalBlocks(
  db: Queryable,
  professionalUserId: number,
  weekday: string,
): Promise<{ start: string; end: string }[]> {
  return query<{ start: string; end: string }>(
    db,
    `SELECT to_char(start_time, 'HH24:MI') AS start, to_char(end_time, 'HH24:MI') AS "end"
       FROM schedule_blocks
      WHERE professional_user_id = $1 AND weekday = $2
      ORDER BY start_time`,
    [professionalUserId, weekday],
  );
}

// Open windows for a resource on a weekday (resources offer no services). Ordered by start.
export function getResourceBlocks(
  db: Queryable,
  resourceId: number,
  weekday: string,
): Promise<{ start: string; end: string }[]> {
  return query<{ start: string; end: string }>(
    db,
    `SELECT to_char(start_time, 'HH24:MI') AS start, to_char(end_time, 'HH24:MI') AS "end"
       FROM schedule_blocks
      WHERE resource_id = $1 AND weekday = $2
      ORDER BY start_time`,
    [resourceId, weekday],
  );
}

// The per-block override (duration/price) for the block containing a slot start, for one service;
// null when the slot falls outside any offering block (e.g. an off-lattice staff sobreturno).
export function getBlockServiceForSlot(
  db: Queryable,
  professionalUserId: number,
  serviceId: number,
  weekday: string,
  startHHMM: string,
): Promise<{ duration_minutes: number | null; price_ars: string | null } | null> {
  return queryOne<{ duration_minutes: number | null; price_ars: string | null }>(
    db,
    `SELECT sbs.duration_minutes, sbs.price_ars
       FROM schedule_blocks sb
       JOIN schedule_block_services sbs
         ON sbs.schedule_block_id = sb.id AND sbs.service_id = $2
      WHERE sb.professional_user_id = $1 AND sb.weekday = $3
        AND sb.start_time <= $4::time AND sb.end_time > $4::time
      LIMIT 1`,
    [professionalUserId, serviceId, weekday, startHHMM],
  );
}

// Effective booking window for (professional, service): the per-service override else the business
// default. Business-scoped so a cross-tenant professional id yields null (caller maps to 404).
export function getEffectiveBookingWindow(
  db: Queryable,
  professionalUserId: number,
  serviceId: number,
  businessId: number,
): Promise<{ min_booking_days: number; max_booking_days: number | null } | null> {
  return queryOne<{ min_booking_days: number; max_booking_days: number | null }>(
    db,
    `SELECT COALESCE(ps.min_booking_days, b.min_booking_days) AS min_booking_days,
            COALESCE(ps.max_booking_days, b.max_booking_days) AS max_booking_days
       FROM auth.users u
       JOIN businesses b ON b.id = u.business_id
       LEFT JOIN professional_services ps
         ON ps.professional_user_id = u.id AND ps.service_id = $2
      WHERE u.id = $1 AND u.business_id = $3`,
    [professionalUserId, serviceId, businessId],
  );
}

export function getScheduleExceptions(
  db: Queryable,
  ownerCol: string,
  ownerId: number,
  date: string,
): Promise<ScheduleExceptionRow[]> {
  return query<ScheduleExceptionRow>(
    db,
    `SELECT ${EXCEPTION_PROJECTION}
       FROM schedule_exceptions
      WHERE ${ownerCol} = $1 AND exception_date = $2::date`,
    [ownerId, date],
  );
}

// Business-wide closures for a business on a date: schedule_exceptions rows owned by the business
// (both per-owner columns null). Unioned into every professional's and resource's exceptions on each
// owner lookup, so a clinic closure blocks the whole business. Keyed by (business_id, exception_date).
export function getBusinessClosures(
  db: Queryable,
  businessId: number,
  date: string,
): Promise<ScheduleExceptionRow[]> {
  return query<ScheduleExceptionRow>(
    db,
    `SELECT ${EXCEPTION_PROJECTION}
       FROM schedule_exceptions
      WHERE business_id = $1 AND exception_date = $2::date`,
    [businessId, date],
  );
}

// A business-wide closure is a schedule_exceptions row owned by the business (both owner columns
// null). is_unavailable is always true — a closure only blocks. These four functions are the only
// place that writes/reads business-owned rows; the generic engine only ever touches owned rows.
export function insertBusinessClosure(
  db: Queryable,
  businessId: number,
  data: { exception_date: string; start_time: string | null; end_time: string | null; reason: string | null },
): Promise<BusinessClosureRow | null> {
  return queryOne<BusinessClosureRow>(
    db,
    `INSERT INTO schedule_exceptions (business_id, exception_date, is_unavailable, start_time, end_time, reason)
     VALUES ($1, $2::date, true, $3::time, $4::time, $5)
     RETURNING ${CLOSURE_PROJECTION}`,
    [businessId, data.exception_date, data.start_time, data.end_time, data.reason],
  );
}

export function updateBusinessClosure(
  db: Queryable,
  id: number,
  data: { exception_date: string; start_time: string | null; end_time: string | null; reason: string | null },
): Promise<BusinessClosureRow | null> {
  return queryOne<BusinessClosureRow>(
    db,
    `UPDATE schedule_exceptions
        SET exception_date = $2::date, start_time = $3::time, end_time = $4::time, reason = $5
      WHERE id = $1 AND business_id IS NOT NULL
      RETURNING ${CLOSURE_PROJECTION}`,
    [id, data.exception_date, data.start_time, data.end_time, data.reason],
  );
}

export function listBusinessClosures(db: Queryable, businessId: number): Promise<BusinessClosureRow[]> {
  return query<BusinessClosureRow>(
    db,
    `SELECT ${CLOSURE_PROJECTION}
       FROM schedule_exceptions
      WHERE business_id = $1
      ORDER BY exception_date`,
    [businessId],
  );
}

export function findBusinessClosure(
  db: Queryable,
  id: number,
): Promise<{ id: string; business_id: string | null } | null> {
  return queryOne<{ id: string; business_id: string | null }>(
    db,
    `SELECT id, business_id FROM schedule_exceptions WHERE id = $1 AND business_id IS NOT NULL`,
    [id],
  );
}

export async function deleteBusinessClosure(db: Queryable, id: number): Promise<void> {
  await query(db, `DELETE FROM schedule_exceptions WHERE id = $1 AND business_id IS NOT NULL`, [id]);
}

// SQL predicate: is this an open, future turno whose time overlaps active time-off that applies to
// it — a business-wide closure, or its own professional's unavailable exception? End-exclusive;
// full-day time-off (null times) covers the whole date. Assumes the query aliases appointments AS a
// and joins auth.users AS u on the professional (for u.business_id). `tzParam` is the business TZ
// placeholder. Resource-owned exceptions are intentionally excluded (rooms, not professional time).
export function appointmentInConflictSql(tzParam: string): string {
  return `(
    ${CONFLICT_ELIGIBLE_SQL}
    AND EXISTS (
      SELECT 1 FROM schedule_exceptions se
       WHERE se.is_unavailable = true
         AND se.exception_date = (a.starts_at AT TIME ZONE ${tzParam})::date
         AND (
              (se.professional_user_id IS NULL AND se.resource_id IS NULL AND se.business_id = u.business_id)
           OR se.professional_user_id = a.professional_user_id
         )
         AND (
              se.start_time IS NULL
           OR ${wallClockOverlapSql(tzParam, 'se.start_time', 'se.end_time')}
         )
    )
  )`;
}

// How many open, future turnos a not-yet-inserted time-off would put in conflict — powers the
// warn-then-confirm dialog before a closure or personal exception is saved. Scope is the whole
// business (a closure) or one professional (a personal exception). Full-day when start/end are null.
export async function countAppointmentsHitByTimeOff(
  db: Queryable,
  businessId: number,
  tz: string,
  scope: { kind: 'business' } | { kind: 'professional'; professionalUserId: number },
  timeOff: { date: string; start: string | null; end: string | null },
): Promise<number> {
  const params: SqlParam[] = [businessId, tz, timeOff.date];
  const pBiz = '$1', pTz = '$2', pDate = '$3';

  let scopeSql = '';
  if (scope.kind === 'professional') {
    params.push(scope.professionalUserId);
    scopeSql = `AND a.professional_user_id = $${params.length}`;
  }

  let overlapSql = 'TRUE';
  if (timeOff.start != null && timeOff.end != null) {
    params.push(timeOff.start);
    const pStart = `$${params.length}`;
    params.push(timeOff.end);
    const pEnd = `$${params.length}`;
    overlapSql = wallClockOverlapSql(pTz, `${pStart}::time`, `${pEnd}::time`);
  }

  const rows = await query<{ n: string }>(
    db,
    `SELECT count(*)::text AS n
       FROM appointments a
       JOIN auth.users u ON u.id = a.professional_user_id
      WHERE u.business_id = ${pBiz}
        AND ${CONFLICT_ELIGIBLE_SQL}
        AND (a.starts_at AT TIME ZONE ${pTz})::date = ${pDate}::date
        ${scopeSql}
        AND ${overlapSql}`,
    params,
  );
  return Number(rows[0].n);
}

export function getBookedAppointments(
  db: Queryable,
  ownerCol: string,
  ownerId: number,
  date: string,
  tz: string,
): Promise<BookedAppointmentRow[]> {
  return query<BookedAppointmentRow>(
    db,
    `SELECT id,
            to_char(starts_at AT TIME ZONE $2, 'HH24:MI') AS start,
            to_char(ends_at   AT TIME ZONE $2, 'HH24:MI') AS "end",
            state
       FROM appointments
      WHERE ${ownerCol} = $1
        AND state IN (${OPEN_STATES_SQL})
        AND (starts_at AT TIME ZONE $2)::date = $3::date`,
    [ownerId, tz, date],
  );
}

// The owner (professional XOR resource) of a schedule/schedule_exception row, read from the
// existing row so a generic write can't reassign ownership. physicalTable is code-controlled.
// A professional-only owner-guarded table (e.g. professional_services) has no resource_id column,
// so the caller passes hasResourceOwner=false and resource_id comes back null.
export function getScheduleOwnerRow(
  db: Queryable,
  physicalTable: string,
  id: SqlParam,
  hasResourceOwner = true,
): Promise<{ professional_user_id: string | null; resource_id: string | null } | null> {
  const cols = hasResourceOwner
    ? 'professional_user_id, resource_id'
    : 'professional_user_id, NULL::bigint AS resource_id';
  return queryOne<{ professional_user_id: string | null; resource_id: string | null }>(
    db,
    `SELECT ${cols} FROM ${physicalTable} WHERE id = $1`,
    [id],
  );
}

// Per-owner transaction advisory lock (namespaced classid so professional id N and resource id N
// never share a key). Auto-releases on commit/rollback; serializes same-owner conflict rechecks.
export async function acquireOwnerLock(db: Queryable, classId: number, objId: number): Promise<void> {
  await query(db, 'SELECT pg_advisory_xact_lock($1, $2)', [classId, objId]);
}

