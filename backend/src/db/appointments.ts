import { query, queryOne, queryRequired } from './core';
import type { Queryable, SqlParam } from './core';
import { grantedProfessionalScope } from './grants';
import { appointmentInConflictSql } from './scheduling';
import { reNumberFragment } from './scope';
import { dateBoundConditions } from './date-bounds';
import { orderByClause } from './sort';
import type { ListSort, SortColumns } from './sort';
import type { AppointmentSortField } from '../../../shared/src/ssot/list-sort';
import type { AppointmentRow, AppointmentWallClock } from '../../../shared/src/ssot/query-types';

// Referenced-name projection shared by loadAppointment/listAppointments: service_id/professional_user_id/
// client_user_id are all NOT NULL FKs, so an INNER JOIN never drops a row. Names come from the
// secret-free auth.users_directory view (never auth.users) per the read-surface split in CLAUDE.md.
const APPOINTMENT_NAME_JOINS = `
       JOIN services svc ON svc.id = a.service_id
       JOIN auth.users_directory prof ON prof.id = a.professional_user_id
       JOIN auth.users_directory cli ON cli.id = a.client_user_id`;
const APPOINTMENT_NAME_COLUMNS = `svc.name AS service_name, prof.display_name AS professional_name, cli.display_name AS client_name`;

// Null when absent or cross-tenant — both surface as 404 to hide existence.
export function loadAppointment(db: Queryable, id: number, businessId: number): Promise<AppointmentRow | null> {
  return queryOne<AppointmentRow>(
    db,
    `SELECT a.*, ${APPOINTMENT_NAME_COLUMNS}
       FROM appointments a
       JOIN auth.users u ON u.id = a.professional_user_id
       ${APPOINTMENT_NAME_JOINS}
      WHERE a.id = $1 AND u.business_id = $2`,
    [id, businessId],
  );
}

// Wall-clock date/start derived in SQL (mirrors how scheduling reads booked slot times) —
// avoids locale-string round-trips that drift at timezone boundaries.
export function getAppointmentWallClock(db: Queryable, id: number, tz: string): Promise<AppointmentWallClock | null> {
  return queryOne<{ date_str: string; start_str: string }>(
    db,
    `SELECT to_char(starts_at AT TIME ZONE $1, 'YYYY-MM-DD') AS date_str,
            to_char(starts_at AT TIME ZONE $1, 'HH24:MI')   AS start_str
       FROM appointments WHERE id = $2`,
    [tz, id],
  ).then((r) => (r ? { date: r.date_str, start: r.start_str } : null));
}

export function insertRequestedAppointment(
  db: Queryable,
  a: {
    clientUserId: number;
    professionalUserId: number;
    serviceId: number;
    startsAt: string;
    durationMinutes: number;
    price: string;
    name: string | null;
    description: string | null;
  },
): Promise<AppointmentRow> {
  return queryRequired<AppointmentRow>(
    db,
    `INSERT INTO appointments
       (client_user_id, professional_user_id, service_id,
        starts_at, duration_minutes, state, price,
        override_conflict, override_actor_id, name, description)
     VALUES ($1, $2, $3, $4, $5, 'requested', $6, false, null, $7, $8)
     RETURNING *`,
    [a.clientUserId, a.professionalUserId, a.serviceId, a.startsAt, a.durationMinutes, a.price, a.name, a.description],
  );
}

export function insertScheduledAppointment(
  db: Queryable,
  a: {
    clientUserId: number;
    professionalUserId: number;
    resourceId: number | null;
    serviceId: number;
    startsAt: string;
    durationMinutes: number;
    price: string;
    overrideConflict: boolean;
    overrideActorId: number | null;
    name: string | null;
    description: string | null;
    // Links a materialize-on-touch occurrence back to its recurrence rule. Absent for every
    // existing caller, so the columns default to null and behavior is unchanged.
    seriesId?: number | null;
    occurrenceDate?: string | null;
  },
): Promise<AppointmentRow> {
  return queryRequired<AppointmentRow>(
    db,
    `INSERT INTO appointments
       (client_user_id, professional_user_id, resource_id, service_id,
        starts_at, duration_minutes, state, price,
        override_conflict, override_actor_id, name, description,
        series_id, occurrence_date)
     VALUES ($1, $2, $3, $4, $5, $6, 'scheduled', $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      a.clientUserId, a.professionalUserId, a.resourceId, a.serviceId, a.startsAt,
      a.durationMinutes, a.price, a.overrideConflict, a.overrideActorId, a.name, a.description,
      a.seriesId ?? null, a.occurrenceDate ?? null,
    ],
  );
}

export function approveAppointment(
  db: Queryable,
  id: number,
  o: { overrideConflict: boolean; overrideActorId: number | string | null },
): Promise<AppointmentRow | null> {
  return queryOne<AppointmentRow>(
    db,
    `UPDATE appointments
        SET state = 'scheduled',
            override_conflict = $1,
            override_actor_id = $2
      WHERE id = $3
      RETURNING *`,
    [o.overrideConflict, o.overrideActorId, id],
  );
}

export function rescheduleAppointment(
  db: Queryable,
  id: number,
  a: {
    professionalUserId: number;
    serviceId: number;
    resourceId: number | null;
    startsAt: string;
    durationMinutes: number;
    price: string;
    overrideConflict: boolean;
    overrideActorId: number | null;
    name: string | null;
    description: string | null;
  },
): Promise<AppointmentRow | null> {
  return queryOne<AppointmentRow>(
    db,
    `UPDATE appointments
        SET professional_user_id = $1,
            service_id            = $2,
            resource_id           = $3,
            starts_at             = $4,
            duration_minutes      = $5,
            price                 = $6,
            override_conflict     = $7,
            override_actor_id     = $8,
            name                  = COALESCE($9, name),
            description           = COALESCE($10, description)
      WHERE id = $11
      RETURNING *`,
    [
      a.professionalUserId, a.serviceId, a.resourceId, a.startsAt, a.durationMinutes,
      a.price, a.overrideConflict, a.overrideActorId, a.name, a.description, id,
    ],
  );
}

export function setAppointmentConflictIgnored(db: Queryable, id: number, ignored: boolean): Promise<AppointmentRow | null> {
  return queryOne<AppointmentRow>(
    db,
    `UPDATE appointments SET conflict_ignored = $1 WHERE id = $2 RETURNING *`,
    [ignored, id],
  );
}

export function transitionAppointmentState(db: Queryable, id: number, to: string): Promise<AppointmentRow | null> {
  return queryOne<AppointmentRow>(
    db,
    `UPDATE appointments SET state = $1 WHERE id = $2 RETURNING *`,
    [to, id],
  );
}

// Caller guarantees at least one field is present.
export function patchAppointmentFields(
  db: Queryable,
  id: number,
  fields: { name?: string; description?: string; staffNote?: string },
): Promise<AppointmentRow | null> {
  const set: string[] = [];
  const params: SqlParam[] = [];
  let p = 1;
  if (fields.name !== undefined) { set.push(`name = $${p++}`); params.push(fields.name); }
  if (fields.description !== undefined) { set.push(`description = $${p++}`); params.push(fields.description); }
  if (fields.staffNote !== undefined) { set.push(`staff_note = $${p++}`); params.push(fields.staffNote); }
  params.push(id);
  return queryOne<AppointmentRow>(
    db,
    `UPDATE appointments SET ${set.join(', ')} WHERE id = $${p} RETURNING *`,
    params,
  );
}

// Built here (not in routes) so routes stay SQL-free.
export type AppointmentRoleScope =
  | { kind: 'client'; userId: number }
  | { kind: 'professional'; userId: number }
  | { kind: 'receptionist'; granteeUserId: number }
  | { kind: 'all' };

// SQL for each sortable column the shared declaration names. Every other value falls back to the
// default order.
export const APPOINTMENT_SORT_COLUMNS: SortColumns<AppointmentSortField> = {
  starts_at: 'a.starts_at',
  price: 'a.price',
  duration_minutes: 'a.duration_minutes',
  state: 'a.state',
};

// Chronological: a turno list is read as a schedule.
export const APPOINTMENT_DEFAULT_SORT: ListSort<AppointmentSortField> = { column: 'starts_at', dir: 'asc' };

export type AppointmentListFilter = {
  businessId: number;
  sort: ListSort<AppointmentSortField>;
  roleScope: AppointmentRoleScope;
  // Business timezone — feeds the per-row in_conflict flag (turno time vs. time-off, wall-clock).
  tz: string;
  dateFrom?: string;
  dateTo?: string;
  professionalUserId?: number;
  resourceId?: number;
  clientUserId?: number;
  state?: string;
  // Return only turnos that overlap active time-off (open + future, enforced by the predicate).
  conflicting?: boolean;
  limit: number;
  offset: number;
  // Date-range list callers union real rows with virtual (unmaterialized) occurrences and paginate
  // the combined, sorted set in memory — the window bounds the row count, so this fetches every
  // matching real row instead of SQL-paginating a slice that would then be re-sliced. limit/offset
  // are ignored when set.
  unpaginated?: boolean;
};

export async function listAppointments(
  db: Queryable,
  f: AppointmentListFilter,
): Promise<{ rows: AppointmentRow[]; total: number }> {
  const conditions: string[] = ['u.business_id = $1'];
  const params: SqlParam[] = [f.businessId];
  let p = 2;

  if (f.roleScope.kind === 'client') {
    conditions.push(`a.client_user_id = $${p++}`);
    params.push(f.roleScope.userId);
  } else if (f.roleScope.kind === 'professional') {
    conditions.push(`a.professional_user_id = $${p++}`);
    params.push(f.roleScope.userId);
  } else if (f.roleScope.kind === 'receptionist') {
    conditions.push(grantedProfessionalScope('a.professional_user_id', `$${p++}`));
    params.push(f.roleScope.granteeUserId);
  }

  const dates = dateBoundConditions('a.starts_at', { from: f.dateFrom, to: f.dateTo }, p);
  conditions.push(...dates.conditions);
  params.push(...dates.params);
  p = dates.nextIndex;

  if (f.professionalUserId != null) { conditions.push(`a.professional_user_id = $${p++}`); params.push(f.professionalUserId); }
  if (f.resourceId != null) { conditions.push(`a.resource_id = $${p++}`); params.push(f.resourceId); }
  if (f.clientUserId != null) { conditions.push(`a.client_user_id = $${p++}`); params.push(f.clientUserId); }
  if (f.state != null) { conditions.push(`a.state = $${p++}`); params.push(f.state); }
  if (f.conflicting) { conditions.push(appointmentInConflictSql(`$${p++}`)); params.push(f.tz); }

  const where = conditions.join(' AND ');

  // The row query also computes the in_conflict flag, so it carries an extra tz param (after the
  // shared WHERE params) that the count query does not; hence the two build their param lists apart.
  const flagTz = `$${params.length + 1}`;
  const orderBy = orderByClause(APPOINTMENT_SORT_COLUMNS, f.sort, 'a.id');

  if (f.unpaginated) {
    // Every matching row comes back unbounded — total is exactly what was fetched, so there is no
    // separate count query to keep in sync with it.
    const rows = await query<AppointmentRow>(
      db,
      `SELECT a.*, ${appointmentInConflictSql(flagTz)} AS in_conflict, ${APPOINTMENT_NAME_COLUMNS}
         FROM appointments a
         JOIN auth.users u ON u.id = a.professional_user_id
         ${APPOINTMENT_NAME_JOINS}
        WHERE ${where}
        ORDER BY ${orderBy}`,
      [...params, f.tz],
    );
    return { rows, total: rows.length };
  }

  const limitPh = `$${params.length + 2}`;
  const offsetPh = `$${params.length + 3}`;

  // The count query only needs the business-scoping join, never the name joins: it never
  // projects those columns, so adding them would be pure overhead with no consistency benefit.
  const [rows, count] = await Promise.all([
    query<AppointmentRow>(
      db,
      `SELECT a.*, ${appointmentInConflictSql(flagTz)} AS in_conflict, ${APPOINTMENT_NAME_COLUMNS}
         FROM appointments a
         JOIN auth.users u ON u.id = a.professional_user_id
         ${APPOINTMENT_NAME_JOINS}
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT ${limitPh} OFFSET ${offsetPh}`,
      [...params, f.tz, f.limit, f.offset],
    ),
    query<{ n: string }>(
      db,
      `SELECT count(*)::text AS n
         FROM appointments a
         JOIN auth.users u ON u.id = a.professional_user_id
        WHERE ${where}`,
      params,
    ),
  ]);

  return { rows, total: Number(count[0].n) };
}

export type RelatedClientScope = {
  businessId: number;
  professionalUserId?: number;
  granteeUserId?: number;
};

// The single definition of a prior relationship: an appointment links the viewer to the client.
// A Professional counts their own turnos; a Receptionist counts the calendars they are granted.
// Emitted with `?` placeholders (reNumberFragment) so it can be read as a list of ids or embedded
// as a predicate in a larger statement without the two definitions drifting apart.
export function relatedClientIdsFragment(scope: RelatedClientScope): { sql: string; params: SqlParam[] } {
  const conditions: string[] = ['u.business_id = ?', 'a.client_user_id IS NOT NULL'];
  const params: SqlParam[] = [scope.businessId];

  if (scope.professionalUserId != null) {
    conditions.push('a.professional_user_id = ?');
    params.push(scope.professionalUserId);
  } else if (scope.granteeUserId != null) {
    conditions.push(grantedProfessionalScope('a.professional_user_id', '?'));
    params.push(scope.granteeUserId);
  }

  return {
    sql: `SELECT a.client_user_id
            FROM appointments a
            JOIN auth.users u ON u.id = a.professional_user_id
           WHERE ${conditions.join(' AND ')}`,
    params,
  };
}

export async function listRelatedClientIds(db: Queryable, scope: RelatedClientScope): Promise<number[]> {
  const { sql, params } = relatedClientIdsFragment(scope);
  const rows = await query<{ client_user_id: string }>(
    db,
    `SELECT DISTINCT client_user_id FROM (${reNumberFragment(sql, 1).sql}) AS related`,
    params,
  );
  return rows.map((r) => Number(r.client_user_id));
}
