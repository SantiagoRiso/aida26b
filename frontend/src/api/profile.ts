import { apiFetchDecoded } from '@/api/client';
import { authUser } from '@/api/contracts';
import { nullable, object, stringValue } from '@/api/decoders';
import type { ApiResult } from '@/api/client';
import type { AuthUser } from '@shared/ssot/contracts/auth';
import type { SelfProfileRow } from '@shared/ssot/query-types';
import { authPaths } from '@shared/ssot/api-paths';

export type SelfProfile = SelfProfileRow;
const selfProfile = object<SelfProfile>({
  id: stringValue, display_name: stringValue, bio: nullable(stringValue),
  email: stringValue, phone: nullable(stringValue),
});

export interface UpdateProfilePayload {
  display_name: string;
  bio: string | null;
  email: string;
  phone: string | null;
}

export function getMyProfile(): Promise<ApiResult<{ profile: SelfProfile }>> {
  return apiFetchDecoded(object<{ profile: SelfProfile }>({ profile: selfProfile }), authPaths.meProfile());
}

export function updateMyProfile(
  body: UpdateProfilePayload,
): Promise<ApiResult<{ profile: SelfProfile; user: AuthUser }>> {
  return apiFetchDecoded(object<{ profile: SelfProfile; user: AuthUser }>({ profile: selfProfile, user: authUser }), authPaths.meProfile(), {
    method: 'PATCH',
    body: JSON.stringify(body),
  }, { toastOnForbidden: true });
}
