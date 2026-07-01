import type { Pool, PoolClient } from 'pg';
import type { AuthUser } from '../auth';

export type AuthzResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

// Inserts an audit row on the caller's open transaction connection (D-14).
// Does NOT catch errors — the caller's ROLLBACK handles failure, which is correct:
// a lifecycle transition without an audit row must not commit.
export async function auditInTx(
  client: PoolClient,
  user: AuthUser,
  eventType: string,
  outcome: 'success' | 'failure' | 'denied',
  entityId?: number,
  entityType = 'appointments',
  details: Record<string, unknown> = {},
): Promise<void> {
  if (user.business_id == null) return;
  await client.query(
    `INSERT INTO audit_events
       (business_id, actor_user_id, event_type, entity_type, entity_id, outcome, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      user.business_id,
      user.id,
      eventType,
      entityType,
      entityId ?? null,
      outcome,
      JSON.stringify(details),
    ],
  );
}

// Checks whether the caller may act on an appointment owned by a given professional.
// Mirrors assertOwnScheduleAllowed in crud-policy.ts for the appointment domain.
// `db` accepts both Pool and PoolClient so a caller can pass a transaction-bound client
// when the authorization check must be atomic with the write.
export async function assertAppointmentActionAllowed(
  db: Pool | PoolClient,
  user: AuthUser,
  professionalUserId: number,
): Promise<AuthzResult> {
  if (user.role === 'Client') {
    return { ok: false, status: 403, code: 'forbidden', message: 'Clients cannot perform staff actions' };
  }
  if (user.business_id == null) {
    return { ok: false, status: 400, code: 'no_business', message: 'Business context required' };
  }
  if (user.role === 'Admin') return { ok: true };
  if (user.role === 'Professional') {
    return professionalUserId === user.id
      ? { ok: true }
      : { ok: false, status: 403, code: 'forbidden', message: 'Professional may only act on own appointments' };
  }
  // Receptionist: explicit calendar grant required for this professional.
  const grant = await db.query(
    `SELECT 1 FROM calendar_grants WHERE professional_user_id = $1 AND grantee_user_id = $2`,
    [professionalUserId, user.id],
  );
  return grant.rows.length > 0
    ? { ok: true }
    : { ok: false, status: 403, code: 'forbidden', message: 'Calendar grant required for this professional' };
}

// Checks whether the caller may write a ledger entry for a given client.
// `db` must accept a bound PoolClient so the grant/scope check and the ledger INSERT
// are atomic — no revoke-between-check-and-write window on a financial route.
export async function assertLedgerWriteAllowed(
  db: Pool | PoolClient,
  user: AuthUser,
  opts: { clientUserId: number; appointmentId?: number | null; entryType: string },
): Promise<AuthzResult> {
  const { clientUserId, appointmentId, entryType } = opts;

  // Clients never write ledger entries.
  if (user.role === 'Client') {
    return { ok: false, status: 403, code: 'forbidden', message: 'Clients cannot create ledger entries' };
  }
  if (user.business_id == null) {
    return { ok: false, status: 400, code: 'no_business', message: 'Business context required' };
  }

  if (user.role === 'Admin') return { ok: true };

  if (user.role === 'Professional') {
    // Professionals may only bill their own clients; cross-business access is blocked by
    // joining through auth.users to verify business_id (closes cross-business leak).
    const r = await db.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM appointments a
         JOIN auth.users c ON c.id = a.client_user_id
         WHERE a.client_user_id       = $1
           AND a.professional_user_id = $2
           AND c.business_id          = $3
       ) AS allowed`,
      [clientUserId, user.id, user.business_id],
    );
    if (!r.rows[0].allowed) {
      return { ok: false, status: 403, code: 'forbidden', message: 'Professional may only write ledger entries for own clients' };
    }
    return { ok: true };
  }

  // Receptionist: only appointment-linked charges on a granted calendar are permitted.
  // No payments, no adjustments, and no standalone charges.
  if (entryType !== 'charge') {
    return { ok: false, status: 403, code: 'forbidden', message: 'Receptionists may only create charges' };
  }
  if (appointmentId == null) {
    return { ok: false, status: 403, code: 'forbidden', message: 'Receptionists must provide an appointment_id for charges' };
  }
  const r = await db.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM appointments a
       JOIN calendar_grants g ON g.professional_user_id = a.professional_user_id
       WHERE a.id             = $1
         AND a.client_user_id = $2
         AND g.grantee_user_id = $3
     ) AS allowed`,
    [appointmentId, clientUserId, user.id],
  );
  return r.rows[0].allowed
    ? { ok: true }
    : { ok: false, status: 403, code: 'forbidden', message: 'Calendar grant required to create a charge for this appointment' };
}

// Checks whether the caller may read the ledger for a given client (D-25).
export async function assertLedgerReadAllowed(
  db: Pool | PoolClient,
  user: AuthUser,
  clientUserId: number,
): Promise<AuthzResult> {
  // Client may only read their own ledger.
  if (user.role === 'Client') {
    return clientUserId === user.id
      ? { ok: true }
      : { ok: false, status: 403, code: 'forbidden', message: 'Clients may only read their own ledger' };
  }
  if (user.business_id == null) {
    return { ok: false, status: 400, code: 'no_business', message: 'Business context required' };
  }
  if (user.role === 'Admin') {
    // Admin scope is business-bounded — a client in another tenant is not readable.
    const r = await db.query(
      `SELECT 1 FROM auth.users WHERE id = $1 AND business_id = $2`,
      [clientUserId, user.business_id],
    );
    return r.rows.length > 0
      ? { ok: true }
      : { ok: false, status: 404, code: 'not_found', message: 'Client not found in this business' };
  }

  if (user.role === 'Professional') {
    const r = await db.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM appointments
         WHERE client_user_id       = $1
           AND professional_user_id = $2
       ) AS allowed`,
      [clientUserId, user.id],
    );
    return r.rows[0].allowed
      ? { ok: true }
      : { ok: false, status: 403, code: 'forbidden', message: 'Professional may only read ledger for own clients' };
  }

  // Receptionist: may read for clients who share a granted professional.
  // Only consider active/historical real appointments (exclude canceled/rejected noise).
  const r = await db.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM appointments a
       JOIN calendar_grants g ON g.professional_user_id = a.professional_user_id
       WHERE a.client_user_id  = $1
         AND g.grantee_user_id = $2
         AND a.state NOT IN ('canceled', 'rejected')
     ) AS allowed`,
    [clientUserId, user.id],
  );
  return r.rows[0].allowed
    ? { ok: true }
    : { ok: false, status: 403, code: 'forbidden', message: 'Calendar grant required to read ledger for this client' };
}
