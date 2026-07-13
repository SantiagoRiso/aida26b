import { apiFetch } from '@/api/client';
import type { ApiResult } from '@/api/client';

// A business-wide closure: the whole clinic is unavailable on a date (full day when start/end are
// null, otherwise the [start, end) range). Managed by Admins on Negocio; the availability engine
// unions it into every professional's and resource's day.
export interface BusinessClosure {
  id: string;
  exception_date: string;      // 'YYYY-MM-DD'
  start_time: string | null;   // 'HH:MM' or null
  end_time: string | null;
  reason: string | null;
}

export function listClosures(): Promise<ApiResult<BusinessClosure[]>> {
  return apiFetch<BusinessClosure[]>('/business-closures');
}

export function createClosure(body: {
  exception_date: string;
  start_time?: string | null;
  end_time?: string | null;
  reason?: string | null;
}): Promise<ApiResult<BusinessClosure>> {
  return apiFetch<BusinessClosure>('/business-closures', { method: 'POST', body: JSON.stringify(body) });
}

export function updateClosure(id: number | string, body: {
  exception_date: string;
  start_time?: string | null;
  end_time?: string | null;
  reason?: string | null;
}): Promise<ApiResult<BusinessClosure>> {
  return apiFetch<BusinessClosure>(`/business-closures/${id}`, { method: 'PUT', body: JSON.stringify(body) });
}

export function deleteClosure(id: number | string): Promise<ApiResult<{ id: string; deleted: boolean }>> {
  return apiFetch<{ id: string; deleted: boolean }>(`/business-closures/${id}`, { method: 'DELETE' });
}
