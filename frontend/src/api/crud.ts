import { apiFetch } from '@/api/client';
import type { ApiResult } from '@/api/client';
import type { TableKey } from '@shared/types/types';

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

export function listRows<T = Record<string, unknown>>(
  table: TableKey,
  params: ListParams = {},
): Promise<ApiResult<T[]>> {
  return apiFetch<T[]>(`/${table}${buildQuery(params)}`);
}

// Single-row read uses the `?id=` query convention (the generic GET route is /api/:table
// only — there is no /api/:table/:id GET). Assumes a single 'id' primary key.
export function getRow<T = Record<string, unknown>>(
  table: TableKey,
  id: string | number,
): Promise<ApiResult<T>> {
  return apiFetch<T>(`/${table}?id=${encodeURIComponent(id)}`);
}

export function createRow<T = Record<string, unknown>>(
  table: TableKey,
  body: Record<string, unknown>,
): Promise<ApiResult<T>> {
  return apiFetch<T>(`/${table}`, { method: 'POST', body: JSON.stringify(body) });
}

export function updateRow<T = Record<string, unknown>>(
  table: TableKey,
  id: string | number,
  body: Record<string, unknown>,
): Promise<ApiResult<T>> {
  return apiFetch<T>(`/${table}/${id}`, { method: 'PUT', body: JSON.stringify(body) });
}

export function deleteRow(table: TableKey, id: string | number): Promise<ApiResult<unknown>> {
  return apiFetch<unknown>(`/${table}/${id}`, { method: 'DELETE' });
}
