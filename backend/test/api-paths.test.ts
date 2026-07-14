import { describe, it, expect } from 'vitest';
import {
  API_PREFIX,
  crudPath,
  CRUD_PATTERNS,
  AUTH_PATTERNS,
  ADMIN_USER_PATTERNS,
  APPOINTMENT_PATTERNS,
  SCHEDULING_PATTERNS,
  GRANT_PATTERNS,
  LEDGER_PATTERNS,
  AUDIT_PATTERNS,
  BUSINESS_PATTERNS,
  CLOSURE_PATTERNS,
  authPaths,
  adminUserPaths,
  appointmentPaths,
  schedulingPaths,
  grantPaths,
  ledgerPaths,
  auditPaths,
  businessPaths,
  closurePaths,
} from '../../shared/src/ssot/api-paths';

// Pins the complete public URL surface: an accidental edit to any builder changes the
// derived Express pattern and fails here before it can silently move an endpoint.
const EXPECTED_PATTERNS: Record<string, Record<string, string>> = {
  CRUD_PATTERNS: {
    collection: '/api/:tableName',
    item: '/api/:tableName/:id',
  },
  AUTH_PATTERNS: {
    login: '/api/auth/login',
    logout: '/api/auth/logout',
    me: '/api/auth/me',
    changePassword: '/api/auth/change-password',
    meProfile: '/api/auth/me/profile',
  },
  ADMIN_USER_PATTERNS: {
    create: '/api/admin/users',
    deactivate: '/api/admin/users/:id/deactivate',
    resetPassword: '/api/admin/users/:id/reset-password',
    enableLogin: '/api/admin/users/:id/enable-login',
  },
  APPOINTMENT_PATTERNS: {
    list: '/api/appointments',
    detail: '/api/appointments/:id',
    request: '/api/appointments/request',
    schedule: '/api/appointments/schedule',
    approve: '/api/appointments/:id/approve',
    reschedule: '/api/appointments/:id/reschedule',
    transition: '/api/appointments/:id/transition',
    ignoreConflict: '/api/appointments/:id/ignore-conflict',
    relatedClients: '/api/appointments/related-clients',
  },
  SCHEDULING_PATTERNS: {
    conflictCheck: '/api/conflict-check',
    availability: '/api/availability',
    bookingWindow: '/api/booking-window',
    timeOffConflictPreview: '/api/time-off/conflict-preview',
  },
  GRANT_PATTERNS: {
    list: '/api/calendar-grants',
    detail: '/api/calendar-grants/:id',
    grantableStaff: '/api/calendar-grants/grantable-staff',
  },
  LEDGER_PATTERNS: {
    create: '/api/ledger',
    clientBalance: '/api/clients/:id/balance',
    clientLedger: '/api/clients/:id/ledger',
  },
  AUDIT_PATTERNS: {
    list: '/api/audit',
  },
  BUSINESS_PATTERNS: {
    mySettings: '/api/business/settings',
    settings: '/api/businesses/:id/settings',
  },
  CLOSURE_PATTERNS: {
    list: '/api/business-closures',
    detail: '/api/business-closures/:id',
  },
};

const ACTUAL_PATTERNS: Record<string, Record<string, string>> = {
  CRUD_PATTERNS,
  AUTH_PATTERNS,
  ADMIN_USER_PATTERNS,
  APPOINTMENT_PATTERNS,
  SCHEDULING_PATTERNS,
  GRANT_PATTERNS,
  LEDGER_PATTERNS,
  AUDIT_PATTERNS,
  BUSINESS_PATTERNS,
  CLOSURE_PATTERNS,
};

type Builder = (() => string) | ((id: number | string) => string);

const BUILDER_GROUPS: Record<string, Record<string, Builder>> = {
  AUTH_PATTERNS: authPaths,
  ADMIN_USER_PATTERNS: adminUserPaths,
  APPOINTMENT_PATTERNS: appointmentPaths,
  SCHEDULING_PATTERNS: schedulingPaths,
  GRANT_PATTERNS: grantPaths,
  LEDGER_PATTERNS: ledgerPaths,
  AUDIT_PATTERNS: auditPaths,
  BUSINESS_PATTERNS: businessPaths,
  CLOSURE_PATTERNS: closurePaths,
};

describe('API path patterns (public URL surface)', () => {
  it('every pattern matches its pinned literal', () => {
    expect(ACTUAL_PATTERNS).toEqual(EXPECTED_PATTERNS);
  });

  it('every builder output composed with API_PREFIX equals its pattern (sample id substituted)', () => {
    for (const [group, builders] of Object.entries(BUILDER_GROUPS)) {
      for (const [key, build] of Object.entries(builders)) {
        const built =
          build.length === 0 ? (build as () => string)() : (build as (id: number | string) => string)(7);
        const expected = ACTUAL_PATTERNS[group][key].replace(':id', '7');
        expect(`${API_PREFIX}${built}`, `${group}.${key}`).toBe(expected);
      }
    }
  });

  it('crudPath composes the generic CRUD patterns', () => {
    expect(`${API_PREFIX}${crudPath('services')}`).toBe(CRUD_PATTERNS.collection.replace(':tableName', 'services'));
    expect(`${API_PREFIX}${crudPath('services', 7)}`).toBe(
      CRUD_PATTERNS.item.replace(':tableName', 'services').replace(':id', '7'),
    );
  });

  it('builders and patterns cover the same endpoint keys', () => {
    for (const [group, builders] of Object.entries(BUILDER_GROUPS)) {
      expect(Object.keys(ACTUAL_PATTERNS[group]).sort(), group).toEqual(Object.keys(builders).sort());
    }
  });
});
