import { apiFetch } from '@/api/client';
import type { ApiResult } from '@/api/client';
import type { TableKey, TableRecordMap } from '@shared/types/types';

export interface ListParams {
  page?: number;
  limit?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  // Per-field filters. Value semantics:
  //   string   → ILIKE filter
  //   !string  → negated ILIKE filter
  //   'min,max' → numeric range (either bound may be omitted: ',max' or 'min,')
  filters?: Record<string, string>;
}

function buildQuery(params: ListParams): string {
  const parts: string[] = [];

  if (params.page && params.page > 1) parts.push(`page=${params.page}`);
  if (params.limit) parts.push(`limit=${params.limit}`);
  if (params.sort) parts.push(`sort=${encodeURIComponent(params.sort)}`);
  if (params.dir) parts.push(`dir=${params.dir}`);

  if (params.filters) {
    for (const [field, value] of Object.entries(params.filters)) {
      if (value !== '' && value !== undefined) {
        parts.push(`filter_${encodeURIComponent(field)}=${encodeURIComponent(value)}`);
      }
    }
  }

  return parts.length ? `?${parts.join('&')}` : '';
}

export function listRows<K extends TableKey>(
  table: K,
  params: ListParams = {},
): Promise<ApiResult<TableRecordMap[K][]>> {
  return apiFetch<TableRecordMap[K][]>(`/${table}${buildQuery(params)}`);
}

// Single-row read uses the `?id=` query convention (the generic GET route is /api/:table
// only — there is no /api/:table/:id GET). Assumes a single 'id' primary key.
export function getRow<K extends TableKey>(
  table: K,
  id: string | number,
): Promise<ApiResult<TableRecordMap[K]>> {
  return apiFetch<TableRecordMap[K]>(`/${table}?id=${encodeURIComponent(id)}`);
}

export function createRow<K extends TableKey>(
  table: K,
  body: Partial<TableRecordMap[K]>,
): Promise<ApiResult<TableRecordMap[K]>> {
  return apiFetch<TableRecordMap[K]>(`/${table}`, { method: 'POST', body: JSON.stringify(body) });
}

export function updateRow<K extends TableKey>(
  table: K,
  id: string | number,
  body: Partial<TableRecordMap[K]>,
): Promise<ApiResult<TableRecordMap[K]>> {
  return apiFetch<TableRecordMap[K]>(`/${table}/${id}`, { method: 'PUT', body: JSON.stringify(body) });
}

// The backend DELETE returns the removed (or soft-delete-archived) row via RETURNING *.
export function deleteRow<K extends TableKey>(
  table: K,
  id: string | number,
): Promise<ApiResult<TableRecordMap[K]>> {
  return apiFetch<TableRecordMap[K]>(`/${table}/${id}`, { method: 'DELETE' });
}
