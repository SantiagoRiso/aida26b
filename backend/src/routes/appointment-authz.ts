import type { Queryable, TransactionClient } from '../db/core';
import type { AuthUser } from '../auth';
import type { ColumnValue } from '../../../shared/src/types/types';
import type { AuditOutcome, LedgerEntryType } from '../../../shared/src/ssot/domain';
import { LEDGER_WRITE_ROLES, RECEPTIONIST_APPOINTMENT_LINKED_TYPES } from '../../../shared/src/ssot/domain';
import { hasCalendarGrant } from '../db/grants';
import { insertAuditEvent } from '../db/audit';
import { NO_BUSINESS_CODE, NO_BUSINESS_MESSAGE } from './business-context';
import {
  professionalHasClientAppointment,
  granteeCanActOnAppointment,
  professionalHasClient,
  granteeReadsClientLedger,
} from '../db/authz';
import { findUser } from '../db/users';

export type AuthzResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

// Does NOT catch errors — a lifecycle transition without an audit row must not commit.
export async function auditInTx(
  client: TransactionClient,
  user: AuthUser,
  eventType: string,
  outcome: AuditOutcome,
  entityId?: number,
  entityType = 'appointments',
  details: Record<string, ColumnValue | string[]> = {},
): Promise<void> {
  // Tenantless actors never reach here: this records only successful lifecycle events, and every
  // caller's authz guard rejects a null-business actor before the write. Kept as a floor so a
  // tenantless success can't slip an in-tx row past the guard on this uncatchable path. Tenantless
  // *denials* are recorded by the pool-based writer instead (see createAuditWriter).
  if (user.business_id == null) return;
  await insertAuditEvent(client, {
    businessId: user.business_id,
    actorId: user.id,
    eventType,
    entityType,
    entityId: entityId ?? null,
    outcome,
    ip: null,
    detailsJson: JSON.stringify(details),
  });
}

// A forced save (sobreturno) is a fact of its own, separate from the booking it rode in on: the
// same appointment can be scheduled, approved and rescheduled, and each of those may or may not
// have bypassed a real conflict. Emitted alongside the lifecycle event so an auditor can filter
// overrides without knowing which operation produced them.
export const CONFLICT_OVERRIDE_EVENT = 'conflict_override';

export async function auditConflictOverrideInTx(
  client: TransactionClient,
  user: AuthUser,
  appointmentId: number,
  operation: 'schedule' | 'approve' | 'reschedule' | 'materialize',
): Promise<void> {
  await auditInTx(client, user, CONFLICT_OVERRIDE_EVENT, 'success', appointmentId, 'appointments', {
    operation,
  });
}

// `db` accepts any query executor so a caller can pass a transaction-bound client
// when the authorization check must be atomic with the write.
export async function assertAppointmentActionAllowed(
  db: Queryable,
  user: AuthUser,
  professionalUserId: number,
): Promise<AuthzResult> {
  if (user.role === 'Client') {
    return { ok: false, status: 403, code: 'forbidden', message: 'Clients cannot perform staff actions' };
  }
  if (user.business_id == null) {
    return { ok: false, status: 400, code: NO_BUSINESS_CODE, message: NO_BUSINESS_MESSAGE };
  }
  if (user.role === 'Admin') return { ok: true };
  if (user.role === 'Professional') {
    return professionalUserId === user.id
      ? { ok: true }
      : { ok: false, status: 403, code: 'forbidden', message: 'Professional may only act on own appointments' };
  }
  // Receptionist: explicit calendar grant required.
  return (await hasCalendarGrant(db, professionalUserId, user.id))
    ? { ok: true }
    : { ok: false, status: 403, code: 'forbidden', message: 'Calendar grant required for this professional' };
}

// `db` must be a bound transaction executor so the grant check and the ledger INSERT are atomic —
// no revoke-between-check-and-write window on a financial route.
export async function assertLedgerWriteAllowed(
  db: Queryable,
  user: AuthUser,
  opts: { clientUserId: number; appointmentId?: number | null; entryType: string },
): Promise<AuthzResult> {
  const { clientUserId, appointmentId, entryType } = opts;

  if (!LEDGER_WRITE_ROLES.includes(user.role)) {
    return { ok: false, status: 403, code: 'forbidden', message: 'Clients cannot create ledger entries' };
  }
  if (user.business_id == null) {
    return { ok: false, status: 400, code: NO_BUSINESS_CODE, message: NO_BUSINESS_MESSAGE };
  }

  if (user.role === 'Admin') return { ok: true };

  if (user.role === 'Professional') {
    const allowed = await professionalHasClientAppointment(db, clientUserId, user.id, user.business_id);
    return allowed
      ? { ok: true }
      : { ok: false, status: 403, code: 'forbidden', message: 'Professional may only write ledger entries for own clients' };
  }

  // Receptionist. Money against a session names the session: the entry must carry the appointment
  // and the caller must hold a grant on that calendar.
  if (RECEPTIONIST_APPOINTMENT_LINKED_TYPES.includes(entryType as LedgerEntryType)) {
    if (appointmentId == null) {
      return { ok: false, status: 403, code: 'forbidden', message: 'Receptionists must provide an appointment_id' };
    }
    const allowed = await granteeCanActOnAppointment(db, appointmentId, clientUserId, user.id);
    return allowed
      ? { ok: true }
      : { ok: false, status: 403, code: 'forbidden', message: 'Calendar grant required to create a charge for this appointment' };
  }

  // An adjustment corrects a balance rather than settling a session, so there is no appointment to
  // authorize against. Scope it to the clients whose ledger this grant already exposes: correcting
  // a balance you may not even read would be a wider power than reading it.
  const allowed = await granteeReadsClientLedger(db, clientUserId, user.id);
  return allowed
    ? { ok: true }
    : { ok: false, status: 403, code: 'forbidden', message: 'Calendar grant required to adjust this client balance' };
}

export async function assertLedgerReadAllowed(
  db: Queryable,
  user: AuthUser,
  clientUserId: number,
): Promise<AuthzResult> {
  if (user.role === 'Client') {
    return clientUserId === user.id
      ? { ok: true }
      : { ok: false, status: 403, code: 'forbidden', message: 'Clients may only read their own ledger' };
  }
  if (user.business_id == null) {
    return { ok: false, status: 400, code: NO_BUSINESS_CODE, message: NO_BUSINESS_MESSAGE };
  }
  if (user.role === 'Admin') {
    // Admin scope is business-bounded — a client in another tenant is not readable.
    // No activeOnly: a deactivated client's ledger history stays readable.
    const allowed = await findUser(db, { id: clientUserId, businessId: user.business_id });
    return allowed != null
      ? { ok: true }
      : { ok: false, status: 404, code: 'not_found', message: 'Client not found in this business' };
  }

  if (user.role === 'Professional') {
    const allowed = await professionalHasClient(db, clientUserId, user.id);
    return allowed
      ? { ok: true }
      : { ok: false, status: 403, code: 'forbidden', message: 'Professional may only read ledger for own clients' };
  }

  // Receptionist: may read for clients who share a granted professional (void appointments excluded).
  const allowed = await granteeReadsClientLedger(db, clientUserId, user.id);
  return allowed
    ? { ok: true }
    : { ok: false, status: 403, code: 'forbidden', message: 'Calendar grant required to read ledger for this client' };
}
