import { apiFetch } from '@/api/client';
import type { ApiResult } from '@/api/client';

export interface AdminUserPayload {
  // Omitted together for a contact-only client (no login) — see enableClientLogin.
  username?: string;
  email?: string;
  password?: string;
  role: string;
  display_name?: string;
  dni?: string;
}

export interface AdminUserResult {
  id: number | string;
  username: string;
  role: string;
}

// createUser is not admin-only: Professionals/Receptionists may create Clients.
export function createUser(body: AdminUserPayload): Promise<ApiResult<AdminUserResult>> {
  return apiFetch<AdminUserResult>('/admin/users', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function deactivateUser(id: string | number): Promise<ApiResult<{ user: AdminUserResult }>> {
  return apiFetch<{ user: AdminUserResult }>(`/admin/users/${id}/deactivate`, {
    method: 'POST',
  });
}

export function resetPassword(
  id: string | number,
  password: string,
): Promise<ApiResult<{ user: AdminUserResult }>> {
  return apiFetch<{ user: AdminUserResult }>(`/admin/users/${id}/reset-password`, {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

// Turns a contact-only client (no username) into one who can log in.
export function enableClientLogin(
  id: string | number,
  body: { username: string; password: string },
): Promise<ApiResult<{ user: AdminUserResult }>> {
  return apiFetch<{ user: AdminUserResult }>(`/admin/users/${id}/enable-login`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
