import type { ApiResult } from '@/api/result';
import type { ListParams } from '@/api/crud';
import type { TableKey, TableRecordMap } from '@shared/ssot/derived';
import type { Wire } from '@shared/ssot/query-types';

export type CrudFixtures = Partial<{
  [K in TableKey]: Wire<TableRecordMap[K]>[];
}>;

export function listRowsFrom(fixtures: CrudFixtures) {
  return async <K extends TableKey>(table: K, _params?: ListParams): Promise<ApiResult<Wire<TableRecordMap[K]>[]>> => ({
    ok: true,
    data: fixtures[table] ?? [],
  });
}

export function rowResultFrom(fixtures: CrudFixtures) {
  return async <K extends TableKey>(table: K): Promise<ApiResult<Wire<TableRecordMap[K]>>> => {
    const row = fixtures[table]?.[0];
    if (!row) throw new Error(`Missing ${table} fixture`);
    return { ok: true, data: row };
  };
}

export function failedCrud(code: string, message: string, status = 500) {
  return async <K extends TableKey>(): Promise<ApiResult<Wire<TableRecordMap[K]>>> => ({
    ok: false, status, code, message,
  });
}

export function apiSuccess<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

export function apiFailure(code: string, message: string, status = 500): ApiResult<never> {
  return { ok: false, status, code, message };
}
