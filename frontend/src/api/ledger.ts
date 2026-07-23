import { apiFetchDecoded } from '@/api/client';
import { arrayOf, nullable, numberValue, object, stringValue, union } from '@/api/decoders';
import type { ApiResult } from '@/api/client';
import type { LedgerEntryRow, Wire } from '@shared/ssot/query-types';
import { ledgerPaths } from '@shared/ssot/api-paths';
import type { BalanceResult } from '@shared/ssot/contracts/ledger';

export type { BalanceResult } from '@shared/ssot/contracts/ledger';

export type LedgerEntry = Wire<LedgerEntryRow>;
const idValue = union(numberValue, stringValue);
const balanceResult = object<BalanceResult>({ client_user_id: idValue, balance_ars: stringValue });
const ledgerEntry = object<LedgerEntry>({
  id: stringValue, client_user_id: stringValue, appointment_id: nullable(stringValue),
  entry_type: stringValue, amount_ars: stringValue, description: nullable(stringValue),
  actor_user_id: nullable(stringValue), created_at: stringValue,
});

export interface CreateEntryBody {
  client_user_id: number | string;
  entry_type: string;
  amount_ars?: string;
  appointment_id?: number | string;
  description?: string;
}

export function getBalance(clientUserId: number | string): Promise<ApiResult<BalanceResult>> {
  return apiFetchDecoded(balanceResult, ledgerPaths.clientBalance(clientUserId));
}

// Ordering is server-side and allowlisted there; an unknown column falls back to the default order.
export interface LedgerSort {
  sort?: string;
  dir?: 'asc' | 'desc';
}

export function getLedger(
  clientUserId: number | string,
  page = 1,
  limit = 50,
  order: LedgerSort = {},
): Promise<ApiResult<LedgerEntry[]>> {
  const params = new URLSearchParams();
  if (page > 1) params.set('page', String(page));
  params.set('limit', String(limit));
  if (order.sort) {
    params.set('sort', order.sort);
    params.set('dir', order.dir ?? 'asc');
  }
  const qs = params.toString();
  return apiFetchDecoded(arrayOf(ledgerEntry), `${ledgerPaths.clientLedger(clientUserId)}${qs ? `?${qs}` : ''}`);
}

export function createEntry(body: CreateEntryBody): Promise<ApiResult<LedgerEntry>> {
  return apiFetchDecoded(ledgerEntry, ledgerPaths.create(), { method: 'POST', body: JSON.stringify(body) }, { toastOnForbidden: true });
}
