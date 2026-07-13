import { query } from './core';
import type { Queryable } from './core';
import { grantedAppointmentJoin } from './grants';
import { VOID_APPOINTMENT_STATES } from '../../../shared/src/ssot/domain';

// SQL list literal of the void states, built from the shared SSOT const (code-owned values,
// never user input) so the "real service history" filter can never drift from the calendar's.
const VOID_STATES_SQL = VOID_APPOINTMENT_STATES.map((s) => `'${s}'`).join(', ');

// EXISTS probes backing the ledger/appointment authorization decisions. Boolean-only; the policy
// (which role, which message) stays in appointment-authz.ts.

// Joins through auth.users.business_id to close the cross-business leak.
export async function professionalHasClientAppointment(
  db: Queryable,
  clientUserId: number,
  professionalUserId: number,
  businessId: number,
): Promise<boolean> {
  const rows = await query<{ allowed: boolean }>(
    db,
    `SELECT EXISTS (
       SELECT 1
       FROM appointments a
       JOIN auth.users c ON c.id = a.client_user_id
       WHERE a.client_user_id       = $1
         AND a.professional_user_id = $2
         AND c.business_id          = $3
     ) AS allowed`,
    [clientUserId, professionalUserId, businessId],
  );
  return rows[0].allowed;
}

export async function granteeCanActOnAppointment(
  db: Queryable,
  appointmentId: number,
  clientUserId: number,
  granteeUserId: number,
): Promise<boolean> {
  const rows = await query<{ allowed: boolean }>(
    db,
    `SELECT EXISTS (
       SELECT 1
       FROM appointments a
       ${grantedAppointmentJoin('$3')}
       WHERE a.id             = $1
         AND a.client_user_id = $2
     ) AS allowed`,
    [appointmentId, clientUserId, granteeUserId],
  );
  return rows[0].allowed;
}

// A user with this id exists in the business (admin ledger-read tenant bound).
export async function userExistsInBusiness(db: Queryable, userId: number, businessId: number): Promise<boolean> {
  const rows = await query(
    db,
    `SELECT 1 FROM auth.users WHERE id = $1 AND business_id = $2`,
    [userId, businessId],
  );
  return rows.length > 0;
}

// A professional has any appointment with this client (ledger read).
export async function professionalHasClient(db: Queryable, clientUserId: number, professionalUserId: number): Promise<boolean> {
  const rows = await query<{ allowed: boolean }>(
    db,
    `SELECT EXISTS (
       SELECT 1 FROM appointments
       WHERE client_user_id       = $1
         AND professional_user_id = $2
     ) AS allowed`,
    [clientUserId, professionalUserId],
  );
  return rows[0].allowed;
}

// A grantee may read this client's ledger: shares a granted professional via a non-void
// appointment (canceled/rejected excluded — only real service history qualifies).
export async function granteeReadsClientLedger(db: Queryable, clientUserId: number, granteeUserId: number): Promise<boolean> {
  const rows = await query<{ allowed: boolean }>(
    db,
    `SELECT EXISTS (
       SELECT 1
       FROM appointments a
       ${grantedAppointmentJoin('$2')}
       WHERE a.client_user_id  = $1
         AND a.state NOT IN (${VOID_STATES_SQL})
     ) AS allowed`,
    [clientUserId, granteeUserId],
  );
  return rows[0].allowed;
}
