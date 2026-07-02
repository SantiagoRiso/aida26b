import { apiFetch } from '@/api/client';
import type { ApiResult } from '@/api/client';

export interface BalanceResult {
  client_user_id: number;
  balance_ars: string;
}

export interface LedgerEntry {
  id: number;
  client_user_id: number;
  appointment_id: number | null;
  entry_type: string;
  amount_ars: string;
  description: string | null;
  actor_user_id: number | null;
  created_at: string;
}

export interface CreateEntryBody {
  client_user_id: number;
  entry_type: string;
  amount_ars?: string;
  appointment_id?: number;
  description?: string;
}

export function getBalance(clientUserId: number): Promise<ApiResult<BalanceResult>> {
  return apiFetch<BalanceResult>(`/clients/${clientUserId}/balance`);
}

export function getLedger(
  clientUserId: number,
  page = 1,
  limit = 50,
): Promise<ApiResult<LedgerEntry[]>> {
  const params = new URLSearchParams();
  if (page > 1) params.set('page', String(page));
  params.set('limit', String(limit));
  const qs = params.toString();
  return apiFetch<LedgerEntry[]>(`/clients/${clientUserId}/ledger${qs ? `?${qs}` : ''}`);
}

export function createEntry(body: CreateEntryBody): Promise<ApiResult<LedgerEntry>> {
  return apiFetch<LedgerEntry>('/ledger', { method: 'POST', body: JSON.stringify(body) });
}
