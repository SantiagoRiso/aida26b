import { defineStore } from 'pinia';
import { apiFetch } from '@/api/client';
import type { Role } from '@shared/types/roles';
import { authPaths } from '@shared/ssot/api-paths';

export interface AuthUser {
  id: number;
  username: string;
  email: string | null;
  role: Role;
  business_id: string | null;
  is_active: boolean;
  must_change_password: boolean;
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null as AuthUser | null,
  }),
  actions: {
    async login(username: string, password: string) {
      // entry-mode: a 401 here is bad credentials, not a session expiry.
      const result = await apiFetch<{ user: AuthUser }>(
        authPaths.login(),
        { method: 'POST', body: JSON.stringify({ username, password }) },
        { authMode: 'entry' },
      );
      if (result.ok) {
        this.user = result.data.user;
      }
      return result;
    },

    async logout() {
      await apiFetch(authPaths.logout(), { method: 'POST' });
      this.user = null;
    },

    async fetchMe() {
      // entry-mode: a 401 here is the normal "not logged in" state on boot, never session-expired.
      const result = await apiFetch<{ user: AuthUser }>(authPaths.me(), {}, { authMode: 'entry' });
      if (result.ok) {
        this.user = result.data.user;
      } else {
        this.user = null;
      }
      return result;
    },

    async changePassword(currentPassword: string, newPassword: string) {
      // Authenticated route: a 401 would flag session-expired (default auth mode).
      const result = await apiFetch<{ user: AuthUser }>(
        authPaths.changePassword(),
        { method: 'POST', body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) },
      );
      if (result.ok && result.data.user) {
        this.user = result.data.user;
      }
      return result;
    },
  },
});
