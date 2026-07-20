import { apiFetchDecoded } from '@/api/client';
import { arrayOf } from '@/api/decoders';
import { tableRecord } from '@/api/ssot-decoder';
import type { ApiResult } from '@/api/client';
import type { TableKey, TableRecordMap } from '@shared/ssot/derived';
import type { Wire } from '@shared/ssot/query-types';
import { listParamEntries } from '@shared/ssot/list-protocol';
import type { ListRequestParams } from '@shared/ssot/list-protocol';
import { crudPath } from '@shared/ssot/api-paths';

export type ListParams = ListRequestParams;

export function buildQuery(params: ListParams): string {
  const parts = listParamEntries(params).map(
    ([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
  );

  return parts.length ? `?${parts.join('&')}` : '';
}

export function listRows<K extends TableKey>(
  table: K,
  params: ListParams = {},
): Promise<ApiResult<Wire<TableRecordMap[K]>[]>> {
  return apiFetchDecoded(arrayOf(tableRecord(table)), `${crudPath(table)}${buildQuery(params)}`);
}

// Single-row read uses the `?id=` query convention (the generic GET route is /api/:table
// only — there is no /api/:table/:id GET). Assumes a single 'id' primary key.
export function getRow<K extends TableKey>(
  table: K,
  id: string | number,
): Promise<ApiResult<Wire<TableRecordMap[K]>>> {
  return apiFetchDecoded(tableRecord(table), `${crudPath(table)}?id=${encodeURIComponent(id)}`);
}

// Nullable columns already carry `| null` in TableRecordMap; the widening here remains only
// for generic builders (e.g. GenericForm) that clear any emptied field by sending explicit
// null — the server decides per column whether null is acceptable.
type WriteBody<K extends TableKey> = { [C in keyof TableRecordMap[K]]?: TableRecordMap[K][C] | null };

export function createRow<K extends TableKey>(
  table: K,
  body: WriteBody<K>,
): Promise<ApiResult<Wire<TableRecordMap[K]>>> {
  return apiFetchDecoded(tableRecord(table), crudPath(table), { method: 'POST', body: JSON.stringify(body) }, { toastOnForbidden: true });
}

export function updateRow<K extends TableKey>(
  table: K,
  id: string | number,
  body: WriteBody<K>,
): Promise<ApiResult<Wire<TableRecordMap[K]>>> {
  return apiFetchDecoded(tableRecord(table), crudPath(table, id), { method: 'PUT', body: JSON.stringify(body) }, { toastOnForbidden: true });
}

// The backend DELETE returns the removed (or soft-delete-archived) row via RETURNING *.
export function deleteRow<K extends TableKey>(
  table: K,
  id: string | number,
): Promise<ApiResult<Wire<TableRecordMap[K]>>> {
  return apiFetchDecoded(tableRecord(table), crudPath(table, id), { method: 'DELETE' }, { toastOnForbidden: true });
}
