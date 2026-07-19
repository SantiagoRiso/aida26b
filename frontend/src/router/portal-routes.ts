import type { RouteRecordRaw } from 'vue-router';
import { SCREEN_ROLES } from './access';

// The parent route map strips the /portal prefix from these paths.

const portalRoutes: RouteRecordRaw[] = [
  {
    path: '/portal/appointments',
    name: 'portal-appointments',
    component: () => import('@/views/portal/AppointmentsView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['portal-appointments'] },
  },
  {
    path: '/portal/balance',
    name: 'portal-balance',
    component: () => import('@/views/portal/BalanceView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['portal-balance'] },
  },
  {
    path: '/portal/preferences',
    name: 'portal-preferences',
    component: () => import('@/views/portal/PreferencesView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['portal-preferences'] },
  },
];

export default portalRoutes;
