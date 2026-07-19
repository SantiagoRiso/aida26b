import { query, queryOne, queryRequired } from './core';
import type { Queryable, SqlParam } from './core';
import { grantedProfessionalScope } from './grants';
import { appointmentInConflictSql } from './scheduling';
import type { AppointmentRow, AppointmentWallClock } from '../../../shared/src/ssot/query-types';

// Null when absent or cross-tenant — both surface as 404 to hide existence.
export function loadAppointment(db: Queryable, id: number, businessId: number): Promise<AppointmentRow | null> {
  return queryOne<AppointmentRow>(
    db,
    `SELECT a.*
       FROM appointments a
       JOIN auth.users u ON u.id = a.professional_user_id
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

export type AppointmentListFilter = {
  businessId: number;
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

  if (f.dateFrom != null) { conditions.push(`a.starts_at >= $${p++}`); params.push(f.dateFrom); }
  if (f.dateTo != null) { conditions.push(`a.starts_at <= $${p++}`); params.push(f.dateTo); }
  if (f.professionalUserId != null) { conditions.push(`a.professional_user_id = $${p++}`); params.push(f.professionalUserId); }
  if (f.resourceId != null) { conditions.push(`a.resource_id = $${p++}`); params.push(f.resourceId); }
  if (f.clientUserId != null) { conditions.push(`a.client_user_id = $${p++}`); params.push(f.clientUserId); }
  if (f.state != null) { conditions.push(`a.state = $${p++}`); params.push(f.state); }
  if (f.conflicting) { conditions.push(appointmentInConflictSql(`$${p++}`)); params.push(f.tz); }

  const where = conditions.join(' AND ');

  // The row query also computes the in_conflict flag, so it carries an extra tz param (after the
  // shared WHERE params) that the count query does not; hence the two build their param lists apart.
  const flagTz = `$${params.length + 1}`;

  if (f.unpaginated) {
    // Every matching row comes back unbounded — total is exactly what was fetched, so there is no
    // separate count query to keep in sync with it.
    const rows = await query<AppointmentRow>(
      db,
      `SELECT a.*, ${appointmentInConflictSql(flagTz)} AS in_conflict
         FROM appointments a
         JOIN auth.users u ON u.id = a.professional_user_id
        WHERE ${where}
        ORDER BY a.starts_at`,
      [...params, f.tz],
    );
    return { rows, total: rows.length };
  }

  const limitPh = `$${params.length + 2}`;
  const offsetPh = `$${params.length + 3}`;

  const [rows, count] = await Promise.all([
    query<AppointmentRow>(
      db,
      `SELECT a.*, ${appointmentInConflictSql(flagTz)} AS in_conflict
         FROM appointments a
         JOIN auth.users u ON u.id = a.professional_user_id
        WHERE ${where}
        ORDER BY a.starts_at
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

export async function listRelatedClientIds(
  db: Queryable,
  opts: { businessId: number; professionalUserId?: number; granteeUserId?: number },
): Promise<number[]> {
  const conditions: string[] = ['u.business_id = $1', 'a.client_user_id IS NOT NULL'];
  const params: SqlParam[] = [opts.businessId];

  if (opts.professionalUserId != null) {
    conditions.push('a.professional_user_id = $2');
    params.push(opts.professionalUserId);
  } else if (opts.granteeUserId != null) {
    conditions.push(grantedProfessionalScope('a.professional_user_id', '$2'));
    params.push(opts.granteeUserId);
  }

  const rows = await query<{ client_user_id: string }>(
    db,
    `SELECT DISTINCT a.client_user_id
       FROM appointments a
       JOIN auth.users u ON u.id = a.professional_user_id
      WHERE ${conditions.join(' AND ')}`,
    params,
  );
  return rows.map((r) => Number(r.client_user_id));
}
