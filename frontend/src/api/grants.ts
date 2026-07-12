import { apiFetch } from '@/api/client';
import type { ApiResult } from '@/api/client';

export interface CalendarGrant {
  id: string;
  professional_user_id: string;
  grantee_user_id: string;
  created_at: string;
  grantee_username: string;
  grantee_role: string;
  professional_name: string;
}
export interface GrantableStaff {
  id: string;
  username: string;
  role: string;
  display_name: string | null;
}

export function listGrants(professionalUserId?: number): Promise<ApiResult<CalendarGrant[]>> {
  const q = professionalUserId != null ? `?professional_user_id=${professionalUserId}` : '';
  return apiFetch<CalendarGrant[]>(`/calendar-grants${q}`);
}
export function listGrantableStaff(): Promise<ApiResult<GrantableStaff[]>> {
  return apiFetch<GrantableStaff[]>('/calendar-grants/grantable-staff');
}
export function createGrant(body: { professional_user_id: number; grantee_user_id: number }): Promise<ApiResult<{ id: string }>> {
  return apiFetch<{ id: string }>('/calendar-grants', { method: 'POST', body: JSON.stringify(body) });
}
export function revokeGrant(id: number | string): Promise<ApiResult<{ id: string; revoked: boolean }>> {
  return apiFetch<{ id: string; revoked: boolean }>(`/calendar-grants/${id}`, { method: 'DELETE' });
}
