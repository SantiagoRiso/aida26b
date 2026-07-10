import { query, queryOne } from './core';
import type { Queryable } from './core';
import type { LedgerEntryRow } from '../../../shared/src/ssot/query-types';
import { LEDGER_DEBIT_TYPES, LEDGER_CREDIT_TYPES } from '../../../shared/src/ssot/domain';

// Post a session charge for a completed appointment, once. The NOT EXISTS guard keeps it
// idempotent if a charge for this appointment was already written. Returns the new entry id,
// or null when a charge already existed. ledger_entries is append-only (writes only).
export function insertSessionChargeIfAbsent(
  db: Queryable,
  c: { clientUserId: string; appointmentId: number; amountArs: string; actorUserId: number },
): Promise<string | null> {
  return queryOne<{ id: string }>(
    db,
    `INSERT INTO ledger_entries
       (client_user_id, appointment_id, entry_type, amount_ars, description, actor_user_id)
     SELECT $1, $2, 'charge', $3, NULL, $4
     WHERE NOT EXISTS (
       SELECT 1 FROM ledger_entries WHERE appointment_id = $2 AND entry_type = 'charge'
     )
     RETURNING id`,
    [c.clientUserId, c.appointmentId, c.amountArs, c.actorUserId],
  ).then((r) => r?.id ?? null);
}

// Charge amount sourced from the appointment's booked price, constrained to the appointment
// owned by the charged client in the caller's business (prevents sourcing a cross-tenant amount).
// Null when no such appointment exists.
export function getAppointmentChargeAmount(
  db: Queryable,
  appointmentId: number,
  clientUserId: number,
  businessId: number,
): Promise<string | null> {
  return queryOne<{ price: string }>(
    db,
    `SELECT a.price
       FROM appointments a
       JOIN auth.users c ON c.id = a.client_user_id
      WHERE a.id = $1 AND a.client_user_id = $2 AND c.business_id = $3`,
    [appointmentId, clientUserId, businessId],
  ).then((r) => r?.price ?? null);
}

export function insertLedgerEntry(
  db: Queryable,
  e: {
    clientUserId: number;
    appointmentId: number | null;
    entryType: string;
    amountArs: string;
    description: string | null;
    actorUserId: number;
  },
): Promise<LedgerEntryRow | null> {
  return queryOne<LedgerEntryRow>(
    db,
    `INSERT INTO ledger_entries
       (client_user_id, appointment_id, entry_type, amount_ars, description, actor_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [e.clientUserId, e.appointmentId, e.entryType, e.amountArs, e.description, e.actorUserId],
  );
}

// Current-account balance = Σ(debits) − Σ(credits); the debit/credit split comes from the SSOT
// entry-type signs, not literals here.
export function getClientBalance(db: Queryable, clientUserId: number): Promise<string> {
  return queryOne<{ balance_ars: string }>(
    db,
    `SELECT
       COALESCE(SUM(amount_ars) FILTER (WHERE entry_type = ANY($2)), 0)
       -
       COALESCE(SUM(amount_ars) FILTER (WHERE entry_type = ANY($3)), 0)
       AS balance_ars
     FROM ledger_entries
     WHERE client_user_id = $1`,
    [clientUserId, LEDGER_DEBIT_TYPES, LEDGER_CREDIT_TYPES],
  ).then((r) => r?.balance_ars ?? '0');
}

export async function listClientLedger(
  db: Queryable,
  clientUserId: number,
  page: { limit: number; offset: number },
): Promise<{ rows: LedgerEntryRow[]; total: number }> {
  const [rows, count] = await Promise.all([
    query<LedgerEntryRow>(
      db,
      `SELECT * FROM ledger_entries
        WHERE client_user_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [clientUserId, page.limit, page.offset],
    ),
    query<{ n: string }>(
      db,
      `SELECT count(*)::text AS n FROM ledger_entries WHERE client_user_id = $1`,
      [clientUserId],
    ),
  ]);
  return { rows, total: Number(count[0].n) };
}
