import { defineStore } from 'pinia';
import { apiFetchDecoded } from '@/api/client';
import { undefinedValue } from '@/api/decoders';
import { wrappedAuthUser } from '@/api/contracts';
import type { Role } from '@shared/types/roles';
import { authPaths } from '@shared/ssot/api-paths';

export interface AuthUser {
  id: number;
  username: string;
  email: string | null;
  role: Role;
  business_id: number | null;
  is_active: boolean;
  must_change_password: boolean;
}

export const useAuthStore = defineStore('auth', {
  state: (): { user: AuthUser | null } => ({
    user: null,
  }),
  actions: {
    async login(username: string, password: string) {
      // entry-mode: a 401 here is bad credentials, not a session expiry.
      const result = await apiFetchDecoded(
        wrappedAuthUser,
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
      // Errors are ignored on purpose (local state clears regardless); a 403 here is unreachable
      // in practice, so no forbidden toast.
      await apiFetchDecoded(undefinedValue, authPaths.logout(), { method: 'POST' });
      this.user = null;
    },

    async fetchMe() {
      // entry-mode: a 401 here is the normal "not logged in" state on boot, never session-expired.
      const result = await apiFetchDecoded(wrappedAuthUser, authPaths.me(), {}, { authMode: 'entry' });
      if (result.ok) {
        this.user = result.data.user;
      } else {
        this.user = null;
      }
      return result;
    },

    async changePassword(currentPassword: string, newPassword: string) {
      // Authenticated route: a 401 would flag session-expired (default auth mode).
      const result = await apiFetchDecoded(
        wrappedAuthUser,
        authPaths.changePassword(),
        { method: 'POST', body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) },
        { toastOnForbidden: true },
      );
      if (result.ok && result.data.user) {
        this.user = result.data.user;
      }
      return result;
    },
  },
});
