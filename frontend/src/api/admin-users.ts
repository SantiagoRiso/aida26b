import { apiFetch } from '@/api/client';
import type { ApiResult } from '@/api/client';

export interface AdminUserPayload {
  username: string;
  email?: string;
  password: string;
  role: string;
  display_name?: string;
}

export interface AdminUserResult {
  id: number | string;
  username: string;
  role: string;
}

// Admin-user management routes use the raw JSON envelope (not the generic envelope).
// Errors arrive as { error: string } — the generic ApiResult maps them to ok:false.

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
