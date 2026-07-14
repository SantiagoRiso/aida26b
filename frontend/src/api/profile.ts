import { apiFetch } from '@/api/client';
import type { ApiResult } from '@/api/client';
import type { AuthUser } from '@/stores/auth';
import type { SelfProfileRow } from '@shared/ssot/query-types';
import { authPaths } from '@shared/ssot/api-paths';

export type SelfProfile = SelfProfileRow;

export interface UpdateProfilePayload {
  display_name: string;
  bio: string | null;
  email: string;
  phone: string | null;
}

export function getMyProfile(): Promise<ApiResult<{ profile: SelfProfile }>> {
  return apiFetch<{ profile: SelfProfile }>(authPaths.meProfile());
}

export function updateMyProfile(
  body: UpdateProfilePayload,
): Promise<ApiResult<{ profile: SelfProfile; user: AuthUser }>> {
  return apiFetch<{ profile: SelfProfile; user: AuthUser }>(authPaths.meProfile(), {
    method: 'PATCH',
    body: JSON.stringify(body),
  }, { toastOnForbidden: true });
}
