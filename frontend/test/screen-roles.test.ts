import { describe, it, expect } from 'vitest';
import { SCREEN_ACCESS, SCREEN_ROLES } from '@/router/access';
import { tableOf } from '@shared/utils/utils';

// Guards the derive-with-narrower-override contract: overrides may only narrow the
// descriptor's read roles, and the resolved map must stay exactly what shipped —
// a descriptor role change that would silently widen or shift a screen fails here.

describe('SCREEN_ACCESS overrides', () => {
  it('every override is a strict subset of the descriptor read roles', () => {
    for (const [screen, entry] of Object.entries(SCREEN_ACCESS)) {
      if (!('table' in entry) || !entry.override) continue;
      const read = tableOf(entry.table).roleRequired?.read ?? [];
      expect(read.length, `${screen}: table '${entry.table}' has no read roles`).toBeGreaterThan(0);
      for (const role of entry.override) {
        expect(read, `${screen}: override role '${role}' not readable on '${entry.table}'`).toContain(role);
      }
      expect(entry.override.length, `${screen}: override equals the read roles — drop it`).toBeLessThan(read.length);
    }
  });

  it('every table-backed screen resolves to a subset of the descriptor read roles', () => {
    for (const [screen, entry] of Object.entries(SCREEN_ACCESS)) {
      if (!('table' in entry)) continue;
      const read = tableOf(entry.table).roleRequired?.read ?? [];
      for (const role of SCREEN_ROLES[screen]) {
        expect(read, `${screen}: resolved role '${role}' not readable on '${entry.table}'`).toContain(role);
      }
    }
  });
});

describe('SCREEN_ROLES resolved map', () => {
  it('matches the shipped access map exactly (zero-change pin)', () => {
    expect(SCREEN_ROLES).toEqual({
      'staff-dashboard': ['Admin', 'Professional', 'Receptionist'],
      'staff-calendar': ['Admin', 'Professional', 'Receptionist'],
      'staff-schedule': ['Admin', 'Professional', 'Receptionist'],
      'staff-requests': ['Admin', 'Professional', 'Receptionist'],
      'staff-clients': ['Admin', 'Professional', 'Receptionist'],
      'staff-professionals': ['Admin', 'Receptionist'],
      'staff-profile': ['Professional'],
      'staff-business': ['Admin'],
      'staff-users': ['Admin'],
      'staff-audit': ['Admin'],
      'staff-settings': ['Admin', 'Professional', 'Receptionist'],
      'portal-appointments': ['Client'],
      'portal-balance': ['Client'],
      'portal-preferences': ['Client'],
    });
  });
});
