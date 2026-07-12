import type { Pool, PoolClient } from 'pg';
import { query, queryOne } from './core';
import type {
  CalendarGrantRow,
  CalendarGrantCreatedRow,
  GrantBusinessRow,
  GrantableStaffRow,
} from '../../../shared/src/ssot/query-types';

// The one place that knows the calendar_grants table shape (professional_user_id, grantee_user_id).
// Every grant-based authorization check routes through here so a change to the grant model is a
// single edit rather than a hunt across the appointment/ledger/schedule routes.

type Queryable = Pool | PoolClient;

export async function hasCalendarGrant(
  db: Queryable,
  professionalUserId: number,
  granteeUserId: number,
): Promise<boolean> {
  const rows = await query(
    db,
    `SELECT 1 FROM calendar_grants WHERE professional_user_id = $1 AND grantee_user_id = $2`,
    [professionalUserId, granteeUserId],
  );
  return rows.length > 0;
}

// SQL fragment scoping a professional-id column to the calendars a grantee may see. `granteeParam`
// is the caller-managed placeholder (e.g. `$3`) whose bound value must be the grantee's user id.
export function grantedProfessionalScope(columnExpr: string, granteeParam: string): string {
  return `${columnExpr} IN (SELECT professional_user_id FROM calendar_grants WHERE grantee_user_id = ${granteeParam})`;
}

// JOIN fragment attaching an appointment (aliased `a`) to the grants held by a grantee. Callers add
// their own WHERE conditions; `granteeParam` is the placeholder bound to the grantee's user id.
export function grantedAppointmentJoin(granteeParam: string): string {
  return `JOIN calendar_grants g ON g.professional_user_id = a.professional_user_id AND g.grantee_user_id = ${granteeParam}`;
}

// Binary grant creation: presence of a row = access.
export function insertCalendarGrant(
  db: Queryable,
  professionalUserId: string,
  granteeUserId: string,
): Promise<CalendarGrantCreatedRow | null> {
  return queryOne<CalendarGrantCreatedRow>(
    db,
    `INSERT INTO calendar_grants (professional_user_id, grantee_user_id)
     VALUES ($1, $2)
     RETURNING id, professional_user_id, grantee_user_id, created_at`,
    [professionalUserId, granteeUserId],
  );
}

// A grant joined to its owning professional's business, for tenant-scoped revoke checks.
export function findGrantWithBusiness(db: Queryable, grantId: number): Promise<GrantBusinessRow | null> {
  return queryOne<GrantBusinessRow>(
    db,
    `SELECT g.id, g.professional_user_id, g.grantee_user_id, u.business_id
       FROM calendar_grants g
       JOIN auth.users u ON u.id = g.professional_user_id
      WHERE g.id = $1`,
    [grantId],
  );
}

// Revoke = hard delete; grants carry no soft-delete.
export async function deleteCalendarGrant(db: Queryable, grantId: number): Promise<void> {
  await query(db, `DELETE FROM calendar_grants WHERE id = $1`, [grantId]);
}

// Grants in a business, created-order, enriched with the grantee's and professional's names
// so the UI can render a grant list without a second lookup. `onlyProfessionalId` narrows to
// one calendar (a Professional sees only their own; admins/receptionists may filter by professional).
export function listCalendarGrants(
  db: Queryable,
  opts: { businessId: number; onlyProfessionalId?: number | string },
): Promise<CalendarGrantRow[]> {
  const conditions = ['u.business_id = $1'];
  const params: (number | string)[] = [opts.businessId];
  if (opts.onlyProfessionalId != null) {
    conditions.push('g.professional_user_id = $2');
    params.push(opts.onlyProfessionalId);
  }
  return query<CalendarGrantRow>(
    db,
    `SELECT g.id, g.professional_user_id, g.grantee_user_id, g.created_at,
            gu.username     AS grantee_username,
            gu.role         AS grantee_role,
            pu.display_name AS professional_name
       FROM calendar_grants g
       JOIN auth.users u  ON u.id  = g.professional_user_id
       JOIN auth.users gu ON gu.id = g.grantee_user_id
       JOIN auth.users pu ON pu.id = g.professional_user_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY g.created_at`,
    params,
  );
}

// Staff who may be granted a calendar (grantee must be Receptionist or Professional),
// scoped to the business. Names come from the secret-free directory view.
export function listGrantableStaff(db: Queryable, businessId: number): Promise<GrantableStaffRow[]> {
  return query<GrantableStaffRow>(
    db,
    `SELECT id, username, role, display_name
       FROM auth.users_directory
      WHERE business_id = $1
        AND is_active = true
        AND role IN ('Receptionist', 'Professional')
      ORDER BY display_name NULLS LAST, username`,
    [businessId],
  );
}
