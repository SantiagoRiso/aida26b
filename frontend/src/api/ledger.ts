import { apiFetch } from '@/api/client';
import type { ApiResult } from '@/api/client';
import type { LedgerEntryRow, Wire } from '@shared/ssot/query-types';
import { ledgerPaths } from '@shared/ssot/api-paths';

export interface BalanceResult {
  client_user_id: number | string;
  balance_ars: string;
}

export type LedgerEntry = Wire<LedgerEntryRow>;

export interface CreateEntryBody {
  client_user_id: number | string;
  entry_type: string;
  amount_ars?: string;
  appointment_id?: number | string;
  description?: string;
}

export function getBalance(clientUserId: number | string): Promise<ApiResult<BalanceResult>> {
  return apiFetch<BalanceResult>(ledgerPaths.clientBalance(clientUserId));
}

export function getLedger(
  clientUserId: number | string,
  page = 1,
  limit = 50,
): Promise<ApiResult<LedgerEntry[]>> {
  const params = new URLSearchParams();
  if (page > 1) params.set('page', String(page));
  params.set('limit', String(limit));
  const qs = params.toString();
  return apiFetch<LedgerEntry[]>(`${ledgerPaths.clientLedger(clientUserId)}${qs ? `?${qs}` : ''}`);
}

export function createEntry(body: CreateEntryBody): Promise<ApiResult<LedgerEntry>> {
  return apiFetch<LedgerEntry>(ledgerPaths.create(), { method: 'POST', body: JSON.stringify(body) });
}
