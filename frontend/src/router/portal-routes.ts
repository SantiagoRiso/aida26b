import type { RouteRecordRaw } from 'vue-router';
import type { Role } from '@shared/types/types';
import { SCREEN_ROLES } from './access';

// The parent route map strips the /portal prefix from these paths.

const portalRoutes: RouteRecordRaw[] = [
  {
    path: '/portal/appointments',
    name: 'portal-appointments',
    component: () => import('@/views/portal/AppointmentsView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['portal-appointments'] as Role[] },
  },
  {
    path: '/portal/request',
    name: 'portal-request',
    component: () => import('@/views/portal/RequestView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['portal-request'] as Role[] },
  },
  {
    path: '/portal/balance',
    name: 'portal-balance',
    component: () => import('@/views/portal/BalanceView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['portal-balance'] as Role[] },
  },
  {
    path: '/portal/preferences',
    name: 'portal-preferences',
    component: () => import('@/views/portal/PreferencesView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['portal-preferences'] as Role[] },
  },
];

export default portalRoutes;
