import { apiFetchDecoded } from '@/api/client';
import { numberValue, object, optional, stringValue, union } from '@/api/decoders';
import type { ApiResult } from '@/api/client';
import { adminUserPaths } from '@shared/ssot/api-paths';
import type { AdminUserResult, CreatedUserResult, EnabledLoginResult } from '@shared/ssot/contracts/users';

export type { AdminUserResult } from '@shared/ssot/contracts/users';

export interface AdminUserPayload {
  // Omitted together for a contact-only client (no login) — see enableClientLogin.
  username?: string;
  email?: string;
  password?: string;
  role: string;
  display_name?: string;
  dni?: string;
}

const adminUserResult = object<AdminUserResult>({ id: union(numberValue, stringValue), username: stringValue, role: stringValue });
const wrappedAdminUserResult = object<{ user: AdminUserResult }>({ user: adminUserResult });
const createdUserResult = object<CreatedUserResult>({
  id: union(numberValue, stringValue), username: optional(stringValue), role: stringValue,
});
const enabledLoginResult = object<EnabledLoginResult>({ id: union(numberValue, stringValue), username: stringValue });

// createUser is not admin-only: Professionals/Receptionists may create Clients.
export function createUser(body: AdminUserPayload): Promise<ApiResult<CreatedUserResult>> {
  return apiFetchDecoded(createdUserResult, adminUserPaths.create(), {
    method: 'POST',
    body: JSON.stringify(body),
  }, { toastOnForbidden: true });
}

export function deactivateUser(id: string | number): Promise<ApiResult<{ user: AdminUserResult }>> {
  return apiFetchDecoded(wrappedAdminUserResult, adminUserPaths.deactivate(id), {
    method: 'POST',
  }, { toastOnForbidden: true });
}

export function resetPassword(
  id: string | number,
  password: string,
): Promise<ApiResult<{ user: AdminUserResult }>> {
  return apiFetchDecoded(wrappedAdminUserResult, adminUserPaths.resetPassword(id), {
    method: 'POST',
    body: JSON.stringify({ password }),
  }, { toastOnForbidden: true });
}

// Turns a contact-only client (no username) into one who can log in.
export function enableClientLogin(
  id: string | number,
  body: { username: string; password: string },
): Promise<ApiResult<EnabledLoginResult>> {
  return apiFetchDecoded(enabledLoginResult, adminUserPaths.enableLogin(id), {
    method: 'POST',
    body: JSON.stringify(body),
  }, { toastOnForbidden: true });
}
