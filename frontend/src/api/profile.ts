import { apiFetch } from '@/api/client';
import type { ApiResult } from '@/api/client';
import type { AuthUser } from '@/stores/auth';

export interface SelfProfile {
  id: string;
  display_name: string;
  bio: string | null;
  email: string;
  phone: string | null;
}

export interface UpdateProfilePayload {
  display_name: string;
  bio: string | null;
  email: string;
  phone: string | null;
}

export function getMyProfile(): Promise<ApiResult<{ profile: SelfProfile }>> {
  return apiFetch<{ profile: SelfProfile }>('/auth/me/profile');
}

export function updateMyProfile(
  body: UpdateProfilePayload,
): Promise<ApiResult<{ profile: SelfProfile; user: AuthUser }>> {
  return apiFetch<{ profile: SelfProfile; user: AuthUser }>('/auth/me/profile', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}
