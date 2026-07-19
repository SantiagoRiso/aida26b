import type { RouteRecordRaw } from 'vue-router';
import { SCREEN_ROLES } from './access';

const staffRoutes: RouteRecordRaw[] = [
  {
    path: '/staff/dashboard',
    name: 'staff-dashboard',
    component: () => import('@/views/staff/DashboardView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['staff-dashboard'] },
  },
  {
    path: '/staff/calendar',
    name: 'staff-calendar',
    component: () => import('@/views/staff/CalendarView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['staff-calendar'] },
  },
  {
    path: '/staff/schedule',
    name: 'staff-schedule',
    component: () => import('@/views/staff/ScheduleEditorView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['staff-schedule'] },
  },
  {
    path: '/staff/requests',
    name: 'staff-requests',
    component: () => import('@/views/staff/RequestsView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['staff-requests'] },
  },
  {
    path: '/staff/clients',
    name: 'staff-clients',
    component: () => import('@/views/staff/ClientsView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['staff-clients'] },
  },
  {
    path: '/staff/professionals',
    name: 'staff-professionals',
    component: () => import('@/views/staff/ProfessionalsView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['staff-professionals'] },
  },
  {
    path: '/staff/business',
    name: 'staff-business',
    component: () => import('@/views/staff/BusinessView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['staff-business'] },
  },
  {
    path: '/staff/users',
    name: 'staff-users',
    component: () => import('@/views/staff/UsersView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['staff-users'] },
  },
  {
    path: '/staff/audit',
    name: 'staff-audit',
    component: () => import('@/views/staff/AuditView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['staff-audit'] },
  },
  {
    path: '/staff/profile',
    name: 'staff-profile',
    component: () => import('@/views/staff/ProfileView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['staff-profile'] },
  },
  {
    path: '/staff/settings',
    name: 'staff-settings',
    component: () => import('@/views/staff/SettingsView.vue'),
    meta: { requiresAuth: true, roles: SCREEN_ROLES['staff-settings'] },
  },
];

export default staffRoutes;
