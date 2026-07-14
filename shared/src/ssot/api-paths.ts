import type { TableKey } from './derived';

// Every URL the API speaks, declared once. Builders return the path WITHOUT the '/api'
// prefix: the frontend client prepends API_PREFIX on fetch, and the backend composes it
// into the Express mount patterns below. Ids travel both as picker numbers and wire
// strings (BIGINT), so path params accept either.

export const API_PREFIX = '/api';

type Id = number | string;

// Generic CRUD surface (/api/:table and /api/:table/:id). Single-row GET is `?id=` on the
// collection path — there is no GET /:table/:id.
export function crudPath(table: TableKey, id?: Id): string {
  return id === undefined ? `/${table}` : `/${table}/${id}`;
}

export const authPaths = {
  login: () => '/auth/login',
  logout: () => '/auth/logout',
  me: () => '/auth/me',
  changePassword: () => '/auth/change-password',
  meProfile: () => '/auth/me/profile',
};

export const adminUserPaths = {
  create: () => '/admin/users',
  deactivate: (id: Id) => `/admin/users/${id}/deactivate`,
  resetPassword: (id: Id) => `/admin/users/${id}/reset-password`,
  enableLogin: (id: Id) => `/admin/users/${id}/enable-login`,
};

export const appointmentPaths = {
  list: () => '/appointments',
  detail: (id: Id) => `/appointments/${id}`,
  request: () => '/appointments/request',
  schedule: () => '/appointments/schedule',
  approve: (id: Id) => `/appointments/${id}/approve`,
  reschedule: (id: Id) => `/appointments/${id}/reschedule`,
  transition: (id: Id) => `/appointments/${id}/transition`,
  ignoreConflict: (id: Id) => `/appointments/${id}/ignore-conflict`,
  relatedClients: () => '/appointments/related-clients',
};

export const schedulingPaths = {
  conflictCheck: () => '/conflict-check',
  availability: () => '/availability',
  bookingWindow: () => '/booking-window',
  timeOffConflictPreview: () => '/time-off/conflict-preview',
};

export const grantPaths = {
  list: () => '/calendar-grants',
  detail: (id: Id) => `/calendar-grants/${id}`,
  grantableStaff: () => '/calendar-grants/grantable-staff',
};

export const ledgerPaths = {
  create: () => '/ledger',
  clientBalance: (clientUserId: Id) => `/clients/${clientUserId}/balance`,
  clientLedger: (clientUserId: Id) => `/clients/${clientUserId}/ledger`,
};

export const auditPaths = {
  list: () => '/audit',
};

export const businessPaths = {
  mySettings: () => '/business/settings',
  settings: (businessId: Id) => `/businesses/${businessId}/settings`,
};

export const closurePaths = {
  list: () => '/business-closures',
  detail: (id: Id) => `/business-closures/${id}`,
};

// Express mount patterns, derived from the builders by substituting ':id' — pattern and
// builder cannot drift because the pattern IS the builder's output.
const pattern = (path: string) => `${API_PREFIX}${path}`;

export const CRUD_PATTERNS = {
  collection: `${API_PREFIX}/:tableName`,
  item: `${API_PREFIX}/:tableName/:id`,
};

export const AUTH_PATTERNS = {
  login: pattern(authPaths.login()),
  logout: pattern(authPaths.logout()),
  me: pattern(authPaths.me()),
  changePassword: pattern(authPaths.changePassword()),
  meProfile: pattern(authPaths.meProfile()),
};

export const ADMIN_USER_PATTERNS = {
  create: pattern(adminUserPaths.create()),
  deactivate: pattern(adminUserPaths.deactivate(':id')),
  resetPassword: pattern(adminUserPaths.resetPassword(':id')),
  enableLogin: pattern(adminUserPaths.enableLogin(':id')),
};

export const APPOINTMENT_PATTERNS = {
  list: pattern(appointmentPaths.list()),
  detail: pattern(appointmentPaths.detail(':id')),
  request: pattern(appointmentPaths.request()),
  schedule: pattern(appointmentPaths.schedule()),
  approve: pattern(appointmentPaths.approve(':id')),
  reschedule: pattern(appointmentPaths.reschedule(':id')),
  transition: pattern(appointmentPaths.transition(':id')),
  ignoreConflict: pattern(appointmentPaths.ignoreConflict(':id')),
  relatedClients: pattern(appointmentPaths.relatedClients()),
};

export const SCHEDULING_PATTERNS = {
  conflictCheck: pattern(schedulingPaths.conflictCheck()),
  availability: pattern(schedulingPaths.availability()),
  bookingWindow: pattern(schedulingPaths.bookingWindow()),
  timeOffConflictPreview: pattern(schedulingPaths.timeOffConflictPreview()),
};

export const GRANT_PATTERNS = {
  list: pattern(grantPaths.list()),
  detail: pattern(grantPaths.detail(':id')),
  grantableStaff: pattern(grantPaths.grantableStaff()),
};

export const LEDGER_PATTERNS = {
  create: pattern(ledgerPaths.create()),
  clientBalance: pattern(ledgerPaths.clientBalance(':id')),
  clientLedger: pattern(ledgerPaths.clientLedger(':id')),
};

export const AUDIT_PATTERNS = {
  list: pattern(auditPaths.list()),
};

export const BUSINESS_PATTERNS = {
  mySettings: pattern(businessPaths.mySettings()),
  settings: pattern(businessPaths.settings(':id')),
};

export const CLOSURE_PATTERNS = {
  list: pattern(closurePaths.list()),
  detail: pattern(closurePaths.detail(':id')),
};
