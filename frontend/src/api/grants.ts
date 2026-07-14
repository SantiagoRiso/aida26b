import { apiFetch } from '@/api/client';
import type { ApiResult } from '@/api/client';
import type { CalendarGrantRow, GrantableStaffRow } from '@shared/ssot/query-types';
import { grantPaths } from '@shared/ssot/api-paths';

export type CalendarGrant = CalendarGrantRow;
export type GrantableStaff = GrantableStaffRow;

export function listGrants(professionalUserId?: number): Promise<ApiResult<CalendarGrant[]>> {
  const q = professionalUserId != null ? `?professional_user_id=${professionalUserId}` : '';
  return apiFetch<CalendarGrant[]>(`${grantPaths.list()}${q}`);
}
export function listGrantableStaff(): Promise<ApiResult<GrantableStaff[]>> {
  return apiFetch<GrantableStaff[]>(grantPaths.grantableStaff());
}
export function createGrant(body: { professional_user_id: number; grantee_user_id: number }): Promise<ApiResult<{ id: string }>> {
  return apiFetch<{ id: string }>(grantPaths.list(), { method: 'POST', body: JSON.stringify(body) });
}
export function revokeGrant(id: number | string): Promise<ApiResult<{ id: string; revoked: boolean }>> {
  return apiFetch<{ id: string; revoked: boolean }>(grantPaths.detail(id), { method: 'DELETE' });
}
