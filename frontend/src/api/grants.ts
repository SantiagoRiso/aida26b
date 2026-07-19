import { apiFetchDecoded } from '@/api/client';
import { arrayOf, booleanValue, nullable, object, stringValue } from '@/api/decoders';
import type { ApiResult } from '@/api/client';
import type { CalendarGrantRow, GrantableStaffRow } from '@shared/ssot/query-types';
import { grantPaths } from '@shared/ssot/api-paths';

export type CalendarGrant = CalendarGrantRow;
export type GrantableStaff = GrantableStaffRow;

const calendarGrant = object<CalendarGrant>({
  id: stringValue, professional_user_id: stringValue, grantee_user_id: stringValue,
  created_at: stringValue, grantee_username: stringValue, grantee_role: stringValue,
  professional_name: stringValue,
});
const grantableStaff = object<GrantableStaff>({
  id: stringValue, username: stringValue, role: stringValue, display_name: nullable(stringValue),
});

export function listGrants(professionalUserId?: number): Promise<ApiResult<CalendarGrant[]>> {
  const q = professionalUserId != null ? `?professional_user_id=${professionalUserId}` : '';
  return apiFetchDecoded(arrayOf(calendarGrant), `${grantPaths.list()}${q}`);
}
export function listGrantableStaff(): Promise<ApiResult<GrantableStaff[]>> {
  return apiFetchDecoded(arrayOf(grantableStaff), grantPaths.grantableStaff());
}
export function createGrant(body: { professional_user_id: number; grantee_user_id: number }): Promise<ApiResult<{ id: string }>> {
  return apiFetchDecoded(object<{ id: string }>({ id: stringValue }), grantPaths.list(), { method: 'POST', body: JSON.stringify(body) }, { toastOnForbidden: true });
}
export function revokeGrant(id: number | string): Promise<ApiResult<{ id: string; revoked: boolean }>> {
  return apiFetchDecoded(object<{ id: string; revoked: boolean }>({ id: stringValue, revoked: booleanValue }), grantPaths.detail(id), { method: 'DELETE' }, { toastOnForbidden: true });
}
