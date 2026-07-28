import { query, queryOne } from './core';
import type { Queryable } from './core';
import type { LedgerEntryRow } from '../../../shared/src/ssot/query-types';
import { LEDGER_DEBIT_TYPES, LEDGER_CREDIT_TYPES } from '../../../shared/src/ssot/domain';
import { orderByClause } from './sort';
import type { ListSort, SortColumns } from './sort';
import type { LedgerSortField } from '../../../shared/src/ssot/list-sort';
import { BUSINESS_TZ } from '../time';

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

// SQL for each sortable column the shared declaration names. Every other value falls back to the
// default order. Qualified with the le. alias: the appointment join below adds its own created_at.
export const LEDGER_SORT_COLUMNS: SortColumns<LedgerSortField> = {
  created_at: 'le.created_at',
  entry_type: 'le.entry_type',
  amount_ars: 'le.amount_ars',
};

// Newest first: a statement is read from the most recent movement backwards.
export const LEDGER_DEFAULT_SORT: ListSort<LedgerSortField> = { column: 'created_at', dir: 'desc' };

// Referenced-name projection: a movement is named by the session it settles (see
// ledgerEntryName), so the list read joins the linked appointment and its service/professional.
// LEFT: an entry may have no appointment_id. On primary/foreign keys only, so no join can
// multiply a ledger_entries row.
const LEDGER_ENTRY_NAME_JOINS = `
       LEFT JOIN appointments a ON a.id = le.appointment_id
       LEFT JOIN services svc ON svc.id = a.service_id
       LEFT JOIN auth.users_directory prof ON prof.id = a.professional_user_id`;

// Entries posted in one transaction share created_at, so the id closes the sort — without a unique
// tiebreaker two pages of the same statement can repeat one entry and never show another.
export async function listClientLedger(
  db: Queryable,
  clientUserId: number,
  page: { limit: number; offset: number; sort: ListSort<LedgerSortField> },
): Promise<{ rows: LedgerEntryRow[]; total: number }> {
  const pageRows = await query<LedgerEntryRow & { total_count: string }>(
    db,
    `SELECT le.*, svc.name AS service_name, prof.display_name AS professional_name,
            to_char(a.starts_at AT TIME ZONE $2, 'DD/MM HH24:MI') AS appointment_when,
            count(*) OVER()::text AS total_count
       FROM ledger_entries le
       ${LEDGER_ENTRY_NAME_JOINS}
      WHERE le.client_user_id = $1
      ORDER BY ${orderByClause(LEDGER_SORT_COLUMNS, page.sort, 'le.id')}
      LIMIT $3 OFFSET $4`,
    [clientUserId, BUSINESS_TZ, page.limit, page.offset],
  );
  if (pageRows.length === 0) {
    // No name join needed: the count is unaffected by joins made on primary/foreign keys.
    const count = await queryOne<{ n: string }>(
      db,
      `SELECT count(*)::text AS n FROM ledger_entries WHERE client_user_id = $1`,
      [clientUserId],
    );
    return { rows: [], total: Number(count?.n ?? 0) };
  }
  const total = Number(pageRows[0].total_count);
  const rows = pageRows.map(({ total_count: _, ...row }) => row as LedgerEntryRow);
  return { rows, total };
}
