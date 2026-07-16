import { apiFetch } from '@/api/client';
import type { ApiResult } from '@/api/client';
import type { BusinessClosureRow } from '@shared/ssot/query-types';
import { closurePaths } from '@shared/ssot/api-paths';

// A business-wide closure: the whole clinic is unavailable on a date (full day when start/end are
// null, otherwise the [start, end) range). Managed by Admins on Negocio; the availability engine
// unions it into every professional's and resource's day.
export type BusinessClosure = BusinessClosureRow;

export function listClosures(options: { signal?: AbortSignal } = {}): Promise<ApiResult<BusinessClosure[]>> {
  return apiFetch<BusinessClosure[]>(closurePaths.list(), { signal: options.signal });
}

export function createClosure(body: {
  exception_date: string;
  start_time?: string | null;
  end_time?: string | null;
  reason?: string | null;
}): Promise<ApiResult<BusinessClosure>> {
  return apiFetch<BusinessClosure>(closurePaths.list(), { method: 'POST', body: JSON.stringify(body) }, { toastOnForbidden: true });
}

export function updateClosure(id: number | string, body: {
  exception_date: string;
  start_time?: string | null;
  end_time?: string | null;
  reason?: string | null;
}): Promise<ApiResult<BusinessClosure>> {
  return apiFetch<BusinessClosure>(closurePaths.detail(id), { method: 'PUT', body: JSON.stringify(body) }, { toastOnForbidden: true });
}

export function deleteClosure(id: number | string): Promise<ApiResult<{ id: string; deleted: boolean }>> {
  return apiFetch<{ id: string; deleted: boolean }>(closurePaths.detail(id), { method: 'DELETE' }, { toastOnForbidden: true });
}
