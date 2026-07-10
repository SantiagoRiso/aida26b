import { query, queryOne } from './core';
import type { Queryable } from './core';
import { OPEN_APPOINTMENT_STATES } from '../../../shared/src/ssot/domain';
import type { WeeklySchedule } from '../../../shared/src/ssot/domain';
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

// weekly is only ever written through validateWeeklySchedule, so reading it back as the class holds.
export function getWeeklySchedule(db: Queryable, ownerCol: string, ownerId: number): Promise<WeeklySchedule> {
  return queryOne<{ weekly: WeeklySchedule }>(
    db,
    `SELECT weekly FROM schedules WHERE ${ownerCol} = $1`,
    [ownerId],
  ).then((r) => r?.weekly ?? {});
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
export function getScheduleOwnerRow(
  db: Queryable,
  physicalTable: string,
  id: SqlParam,
): Promise<{ professional_user_id: string | null; resource_id: string | null } | null> {
  return queryOne<{ professional_user_id: string | null; resource_id: string | null }>(
    db,
    `SELECT professional_user_id, resource_id FROM ${physicalTable} WHERE id = $1`,
    [id],
  );
}

// Per-owner transaction advisory lock (namespaced classid so professional id N and resource id N
// never share a key). Auto-releases on commit/rollback; serializes same-owner conflict rechecks.
export async function acquireOwnerLock(db: Queryable, classId: number, objId: number): Promise<void> {
  await query(db, 'SELECT pg_advisory_xact_lock($1, $2)', [classId, objId]);
}

// Upsert the single schedules row for an owner. weekly is stored opaque (one bound JSON param).
export function upsertSchedule(
  db: Queryable,
  ownerCol: string,
  ownerId: number,
  weeklyJson: string,
): Promise<{ id: string; weekly: WeeklySchedule } | null> {
  return queryOne<{ id: string; weekly: WeeklySchedule }>(
    db,
    `INSERT INTO schedules (${ownerCol}, weekly)
     VALUES ($1, $2)
     ON CONFLICT (${ownerCol}) DO UPDATE SET weekly = EXCLUDED.weekly, updated_at = now()
     RETURNING id, weekly`,
    [ownerId, weeklyJson],
  );
}
