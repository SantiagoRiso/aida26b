import { apiFetch } from '@/api/client';
import type { ApiResult } from '@/api/client';
import type { TableKey, TableRecordMap } from '@shared/ssot/derived';
import { filterParam } from '@shared/ssot/list-protocol';
import { crudPath } from '@shared/ssot/api-paths';

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
        parts.push(`${encodeURIComponent(filterParam(field))}=${encodeURIComponent(value)}`);
      }
    }
  }

  return parts.length ? `?${parts.join('&')}` : '';
}

export function listRows<K extends TableKey>(
  table: K,
  params: ListParams = {},
): Promise<ApiResult<TableRecordMap[K][]>> {
  return apiFetch<TableRecordMap[K][]>(`${crudPath(table)}${buildQuery(params)}`);
}

// Single-row read uses the `?id=` query convention (the generic GET route is /api/:table
// only — there is no /api/:table/:id GET). Assumes a single 'id' primary key.
export function getRow<K extends TableKey>(
  table: K,
  id: string | number,
): Promise<ApiResult<TableRecordMap[K]>> {
  return apiFetch<TableRecordMap[K]>(`${crudPath(table)}?id=${encodeURIComponent(id)}`);
}

// Nullable columns already carry `| null` in TableRecordMap; the widening here remains only
// for generic builders (e.g. GenericForm) that clear any emptied field by sending explicit
// null — the server decides per column whether null is acceptable.
type WriteBody<K extends TableKey> = { [C in keyof TableRecordMap[K]]?: TableRecordMap[K][C] | null };

export function createRow<K extends TableKey>(
  table: K,
  body: WriteBody<K>,
): Promise<ApiResult<TableRecordMap[K]>> {
  return apiFetch<TableRecordMap[K]>(crudPath(table), { method: 'POST', body: JSON.stringify(body) }, { toastOnForbidden: true });
}

export function updateRow<K extends TableKey>(
  table: K,
  id: string | number,
  body: WriteBody<K>,
): Promise<ApiResult<TableRecordMap[K]>> {
  return apiFetch<TableRecordMap[K]>(crudPath(table, id), { method: 'PUT', body: JSON.stringify(body) }, { toastOnForbidden: true });
}

// The backend DELETE returns the removed (or soft-delete-archived) row via RETURNING *.
export function deleteRow<K extends TableKey>(
  table: K,
  id: string | number,
): Promise<ApiResult<TableRecordMap[K]>> {
  return apiFetch<TableRecordMap[K]>(crudPath(table, id), { method: 'DELETE' }, { toastOnForbidden: true });
}
