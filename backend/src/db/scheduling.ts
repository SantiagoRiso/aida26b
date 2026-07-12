import { query, queryOne } from './core';
import type { Queryable } from './core';
import { OPEN_APPOINTMENT_STATES } from '../../../shared/src/ssot/domain';
import type { SqlParam } from '../../../shared/src/types/types';
import type {
  ProfessionalOwnerRow,
  ResourceOwnerRow,
  ScheduleExceptionRow,
  BookedAppointmentRow,
} from '../../../shared/src/ssot/query-types';

// SQL list literal built from the shared open-states const (code-owned values, not user input).
const OPEN_STATES_SQL = OPEN_APPOINTMENT_STATES.map((s) => `'${s}'`).join(', ');

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
// default. null only when the professional row is missing (caller maps to 404).
export function getEffectiveBookingWindow(
  db: Queryable,
  professionalUserId: number,
  serviceId: number,
): Promise<{ min_booking_days: number; max_booking_days: number | null } | null> {
  return queryOne<{ min_booking_days: number; max_booking_days: number | null }>(
    db,
    `SELECT COALESCE(ps.min_booking_days, b.min_booking_days) AS min_booking_days,
            COALESCE(ps.max_booking_days, b.max_booking_days) AS max_booking_days
       FROM auth.users u
       JOIN businesses b ON b.id = u.business_id
       LEFT JOIN professional_services ps
         ON ps.professional_user_id = u.id AND ps.service_id = $2
      WHERE u.id = $1`,
    [professionalUserId, serviceId],
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
    `SELECT is_unavailable,
            to_char(start_time, 'HH24:MI') AS start_time,
            to_char(end_time,   'HH24:MI') AS end_time,
            granularity_minutes
       FROM schedule_exceptions
      WHERE ${ownerCol} = $1 AND exception_date = $2::date`,
    [ownerId, date],
  );
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

