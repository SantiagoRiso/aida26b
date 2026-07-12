import type { RouteRecordRaw } from 'vue-router';
import type { Role } from '@shared/types/types';
import { SCREEN_ROLES } from './access';

const staffRoutes: RouteRecordRaw[] = [
  {
    path: '/staff/dashboard',
    name: 'staff-dashboard',
    component: () => import('@/views/staff/DashboardView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['staff-dashboard'] as Role[] },
  },
  {
    path: '/staff/calendar',
    name: 'staff-calendar',
    component: () => import('@/views/staff/CalendarView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['staff-calendar'] as Role[] },
  },
  {
    path: '/staff/schedule',
    name: 'staff-schedule',
    component: () => import('@/views/staff/ScheduleEditorView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['staff-schedule'] as Role[] },
  },
  {
    path: '/staff/requests',
    name: 'staff-requests',
    component: () => import('@/views/staff/RequestsView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['staff-requests'] as Role[] },
  },
  {
    path: '/staff/clients',
    name: 'staff-clients',
    component: () => import('@/views/staff/ClientsView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['staff-clients'] as Role[] },
  },
  {
    path: '/staff/professionals',
    name: 'staff-professionals',
    component: () => import('@/views/staff/ProfessionalsView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['staff-professionals'] as Role[] },
  },
  {
    path: '/staff/business',
    name: 'staff-business',
    component: () => import('@/views/staff/BusinessView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['staff-business'] as Role[] },
  },
  {
    path: '/staff/users',
    name: 'staff-users',
    component: () => import('@/views/staff/UsersView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['staff-users'] as Role[] },
  },
  {
    path: '/staff/audit',
    name: 'staff-audit',
    component: () => import('@/views/staff/AuditView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['staff-audit'] as Role[] },
  },
  {
    path: '/staff/profile',
    name: 'staff-profile',
    component: () => import('@/views/staff/ProfileView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['staff-profile'] as Role[] },
  },
  {
    path: '/staff/settings',
    name: 'staff-settings',
    component: () => import('@/views/staff/SettingsView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['staff-settings'] as Role[] },
  },
];

export default staffRoutes;
