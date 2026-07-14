import { createRouter, createWebHistory } from 'vue-router';
import type { Role } from '@shared/types/roles';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { roleAllowedFor } from './access';
import staffRoutes from './staff-routes';
import portalRoutes from './portal-routes';

declare module 'vue-router' {
  interface RouteMeta {
    requiresAuth?: boolean;
    roles?: Role[];
  }
}

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/auth/LoginView.vue'),
      meta: { requiresAuth: false },
    },
    {
      path: '/change-password',
      name: 'change-password',
      component: () => import('@/views/auth/ChangePasswordView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/',
      redirect: '/login',
    },
    {
      path: '/staff',
      component: () => import('@/layouts/StaffLayout.vue'),
      children: staffRoutes.map((r) => ({ ...r, path: r.path.replace('/staff/', '') })),
    },
    {
      path: '/portal',
      component: () => import('@/layouts/PortalLayout.vue'),
      children: portalRoutes.map((r) => ({ ...r, path: r.path.replace('/portal/', '') })),
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/login',
    },
  ],
});

router.beforeEach((to) => {
  const auth = useAuthStore();
  const ui = useUiStore();

  if (!auth.user && to.meta.requiresAuth !== false) {
    return { name: 'login' };
  }

  // Already authenticated: /login would dead-end (it never redirects on its own).
  if (auth.user && to.name === 'login') {
    return { name: auth.user.role === 'Client' ? 'portal-appointments' : 'staff-dashboard' };
  }

  if (auth.user?.must_change_password && to.name !== 'change-password') {
    return { name: 'change-password' };
  }

  // Session expired: redirect to login on the next navigation and consume the flag.
  // The current view stays visible until this next navigation (soft redirect, not an abrupt yank).
  if (ui.sessionExpired && to.name !== 'login') {
    ui.sessionExpired = false;
    // Drop the now-dead session's user, or the authenticated-at-/login rule above would bounce this
    // redirect straight back to a role home and never reach /login.
    auth.$reset();
    return { name: 'login' };
  }

  if (to.meta.roles && auth.user && !roleAllowedFor(to.meta.roles, auth.user.role)) {
    ui.toast('error', 'notPermitted');
    return false;
  }
});

export default router;
