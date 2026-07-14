import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRouter, createMemoryHistory } from 'vue-router';
import { setActivePinia, createPinia } from 'pinia';
import { roleAllowedFor, canAccessRoute } from '@/router/access';
import type { Role } from '@shared/types/roles';

function makeAuthStore(user: { role: Role; must_change_password: boolean } | null = null) {
  return { user };
}

function makeUiStore(sessionExpired = false) {
  const toasts: string[] = [];
  return {
    sessionExpired,
    toast: vi.fn((_kind: string, key: string) => { toasts.push(key); }),
    get _toasts() { return toasts; },
  };
}

// Reproduces the real guard chain with injectable mocked stores instead of Pinia,
// so guard branches can be exercised without the app's store wiring.
function buildTestRouter(
  authUser: { role: Role; must_change_password: boolean } | null,
  sessionExpired: boolean,
) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/login', name: 'login', component: { template: '<div/>' }, meta: { requiresAuth: false } },
      { path: '/change-password', name: 'change-password', component: { template: '<div/>' }, meta: { requiresAuth: true } },
      { path: '/staff/dashboard', name: 'staff-dashboard', component: { template: '<div/>' }, meta: { requiresAuth: true, roles: ['Admin', 'Professional', 'Receptionist'] as Role[] } },
      { path: '/staff/users', name: 'staff-users', component: { template: '<div/>' }, meta: { requiresAuth: true, roles: ['Admin'] as Role[] } },
      { path: '/portal/appointments', name: 'portal-appointments', component: { template: '<div/>' }, meta: { requiresAuth: true, roles: ['Client'] as Role[] } },
    ],
  });

  const auth = makeAuthStore(authUser);
  const ui = makeUiStore(sessionExpired);

  router.beforeEach((to) => {
    if (!auth.user && to.meta.requiresAuth !== false) {
      return { name: 'login' };
    }

    if (auth.user?.must_change_password && to.name !== 'change-password') {
      return { name: 'change-password' };
    }

    // Consume the flag so the redirect happens once, then normal nav resumes.
    if (ui.sessionExpired && to.name !== 'login') {
      ui.sessionExpired = false;
      return { name: 'login' };
    }

    // Role mismatch stays put (returns false) rather than redirecting.
    if (to.meta.roles && auth.user) {
      const roles = to.meta.roles as Role[];
      if (!roleAllowedFor(roles, auth.user.role)) {
        ui.toast('error', 'notPermitted');
        return false;
      }
    }
  });

  return { router, ui };
}

describe('roleAllowedFor', () => {
  it('returns true when roles is undefined (any authenticated user)', () => {
    expect(roleAllowedFor(undefined, 'Admin')).toBe(true);
    expect(roleAllowedFor(undefined, 'Client')).toBe(true);
  });

  it('returns true when roles is empty array', () => {
    expect(roleAllowedFor([], 'Professional')).toBe(true);
  });

  it('returns true when role is in the allowed set', () => {
    expect(roleAllowedFor(['Admin', 'Receptionist'], 'Admin')).toBe(true);
    expect(roleAllowedFor(['Admin', 'Receptionist'], 'Receptionist')).toBe(true);
  });

  it('returns false when role is not in the allowed set', () => {
    expect(roleAllowedFor(['Admin'], 'Professional')).toBe(false);
    expect(roleAllowedFor(['Admin'], 'Client')).toBe(false);
    expect(roleAllowedFor(['Client'], 'Admin')).toBe(false);
  });

  it('Admin-only routes reject all non-Admin roles', () => {
    const adminOnly: Role[] = ['Admin'];
    expect(roleAllowedFor(adminOnly, 'Admin')).toBe(true);
    expect(roleAllowedFor(adminOnly, 'Professional')).toBe(false);
    expect(roleAllowedFor(adminOnly, 'Receptionist')).toBe(false);
    expect(roleAllowedFor(adminOnly, 'Client')).toBe(false);
  });

  it('staff routes allow Admin, Professional, Receptionist but not Client', () => {
    const staffRoles: Role[] = ['Admin', 'Professional', 'Receptionist'];
    expect(roleAllowedFor(staffRoles, 'Admin')).toBe(true);
    expect(roleAllowedFor(staffRoles, 'Professional')).toBe(true);
    expect(roleAllowedFor(staffRoles, 'Receptionist')).toBe(true);
    expect(roleAllowedFor(staffRoles, 'Client')).toBe(false);
  });

  it('Client portal routes allow only Client', () => {
    const clientOnly: Role[] = ['Client'];
    expect(roleAllowedFor(clientOnly, 'Client')).toBe(true);
    expect(roleAllowedFor(clientOnly, 'Admin')).toBe(false);
    expect(roleAllowedFor(clientOnly, 'Professional')).toBe(false);
    expect(roleAllowedFor(clientOnly, 'Receptionist')).toBe(false);
  });
});

describe('canAccessRoute', () => {
  it('returns false when user is null', () => {
    expect(canAccessRoute(null, { roles: ['Admin'] })).toBe(false);
  });

  it('returns true when meta has no roles (any authenticated user)', () => {
    expect(canAccessRoute({ role: 'Client' }, {})).toBe(true);
  });

  it('returns true for an allowed role', () => {
    expect(canAccessRoute({ role: 'Admin' }, { roles: ['Admin', 'Receptionist'] })).toBe(true);
  });

  it('returns false for a disallowed role', () => {
    expect(canAccessRoute({ role: 'Client' }, { roles: ['Admin'] })).toBe(false);
  });
});

describe('router guard: Guard 1 — unauthenticated → login', () => {
  it('redirects an unauthenticated user to login when hitting a protected route', async () => {
    const { router } = buildTestRouter(null, false);
    await router.push('/staff/dashboard');
    expect(router.currentRoute.value.name).toBe('login');
  });

  it('allows an unauthenticated user to reach /login directly', async () => {
    const { router } = buildTestRouter(null, false);
    await router.push('/login');
    expect(router.currentRoute.value.name).toBe('login');
  });
});

describe('router guard: Guard 2 — must_change_password locks to change-password', () => {
  it('redirects to change-password when must_change_password is true', async () => {
    const { router } = buildTestRouter({ role: 'Admin', must_change_password: true }, false);
    await router.push('/staff/dashboard');
    expect(router.currentRoute.value.name).toBe('change-password');
  });

  it('allows navigating to change-password itself even when must_change_password is true', async () => {
    const { router } = buildTestRouter({ role: 'Admin', must_change_password: true }, false);
    await router.push('/change-password');
    expect(router.currentRoute.value.name).toBe('change-password');
  });

  it('does NOT redirect when must_change_password is false', async () => {
    const { router } = buildTestRouter({ role: 'Admin', must_change_password: false }, false);
    await router.push('/staff/dashboard');
    expect(router.currentRoute.value.name).toBe('staff-dashboard');
  });
});

describe('router guard: Guard 3 — sessionExpired consumed on next navigation → login', () => {
  it('redirects to login when sessionExpired is true and consumes the flag', async () => {
    const { router, ui } = buildTestRouter({ role: 'Admin', must_change_password: false }, true);
    expect(ui.sessionExpired).toBe(true);
    await router.push('/staff/dashboard');
    expect(router.currentRoute.value.name).toBe('login');
    expect(ui.sessionExpired).toBe(false);
  });

  it('allows navigation after sessionExpired flag is consumed', async () => {
    const { router, ui } = buildTestRouter({ role: 'Admin', must_change_password: false }, true);
    await router.push('/staff/dashboard');
    expect(router.currentRoute.value.name).toBe('login');
    expect(ui.sessionExpired).toBe(false);
  });
});

describe('router guard: Guard 4 — role mismatch → toast + stay put', () => {
  it('pushes a notPermitted toast and stays put when a role is denied', async () => {
    const { router, ui } = buildTestRouter({ role: 'Professional', must_change_password: false }, false);
    await router.push('/staff/dashboard');
    expect(router.currentRoute.value.name).toBe('staff-dashboard');
    await router.push('/staff/users');
    expect(router.currentRoute.value.name).toBe('staff-dashboard');
    expect(ui.toast).toHaveBeenCalledWith('error', 'notPermitted');
  });

  it('allows navigation when role matches', async () => {
    const { router } = buildTestRouter({ role: 'Admin', must_change_password: false }, false);
    await router.push('/staff/users');
    expect(router.currentRoute.value.name).toBe('staff-users');
  });

  it('blocks Client from reaching staff routes and queues notPermitted toast', async () => {
    const { router, ui } = buildTestRouter({ role: 'Client', must_change_password: false }, false);
    await router.push('/portal/appointments');
    expect(router.currentRoute.value.name).toBe('portal-appointments');
    await router.push('/staff/dashboard');
    expect(router.currentRoute.value.name).toBe('portal-appointments');
    expect(ui.toast).toHaveBeenCalledWith('error', 'notPermitted');
  });
});
