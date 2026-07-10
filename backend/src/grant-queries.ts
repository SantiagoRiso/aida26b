import type { Pool, PoolClient } from 'pg';

// The one place that knows the calendar_grants table shape (professional_user_id, grantee_user_id).
// Every grant-based authorization check routes through here so a change to the grant model is a
// single edit rather than a hunt across the appointment/ledger/schedule routes.

// True when the grantee holds a calendar grant for the professional. Used for single-target
// staff-action and schedule-edit gates.
export async function hasCalendarGrant(
  db: Pool | PoolClient,
  professionalUserId: number,
  granteeUserId: number,
): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM calendar_grants WHERE professional_user_id = $1 AND grantee_user_id = $2`,
    [professionalUserId, granteeUserId],
  );
  return r.rows.length > 0;
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
