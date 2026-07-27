import { describe, test, expect } from 'vitest';
import { flagRealConflictsWithVirtuals } from '../src/services/series-listing';
import type { AppointmentRow, VirtualOccurrence } from '../../shared/src/ssot/query-types';

// The reverse-direction conflict flag: a real turno rings when a conflicting virtual occurrence of
// an active recurrence rule overlaps it. Pure function — no DB. NOW is a fixed instant; every
// fixture's time is expressed relative to it so the eligibility gates (open, future, not-ignored)
// are deterministic.
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const HOUR = 3_600_000;

function real(overrides: Partial<AppointmentRow> = {}): AppointmentRow {
  return {
    id: '100',
    client_user_id: '5',
    professional_user_id: '10',
    resource_id: null,
    service_id: '3',
    starts_at: new Date(NOW + HOUR),
    duration_minutes: 30,
    ends_at: new Date(NOW + HOUR + 30 * 60_000),
    state: 'scheduled',
    name: null,
    description: null,
    price: '1500.00',
    override_conflict: false,
    override_actor_id: null,
    staff_note: null,
    created_at: new Date(NOW),
    updated_at: new Date(NOW),
    conflict_ignored: false,
    in_conflict: false,
    series_id: null,
    occurrence_date: null,
    ...overrides,
  };
}

// A virtual occurrence at the same instant as real()'s default (NOW + 1h), 30 min, same professional.
function virtual(overrides: Partial<VirtualOccurrence> = {}): VirtualOccurrence {
  return {
    id: null,
    series_id: '77',
    occurrence_date: '2026-01-15',
    client_user_id: '6',
    professional_user_id: '10',
    service_id: '3',
    resource_id: null,
    starts_at: new Date(NOW + HOUR).toISOString(),
    duration_minutes: 30,
    price: '1500.00',
    state: 'scheduled',
    name: null,
    description: null,
    service_name: 'Consulta',
    professional_name: 'pro_uno',
    client_name: 'cliente_uno',
    is_virtual: true,
    in_conflict: true,
    ...overrides,
  };
}

describe('flagRealConflictsWithVirtuals', () => {
  test('flags a scheduled future real row overlapping a conflicting virtual on the same professional', () => {
    const r = real();
    flagRealConflictsWithVirtuals([r], [virtual()], NOW);
    expect(r.in_conflict).toBe(true);
  });

  test('does not flag when times are only adjacent (end-exclusive overlap)', () => {
    // Virtual runs the 30 min immediately before the real row — they touch at NOW+1h but never overlap.
    const r = real();
    const before = virtual({ starts_at: new Date(NOW + HOUR - 30 * 60_000).toISOString() });
    flagRealConflictsWithVirtuals([r], [before], NOW);
    expect(r.in_conflict).toBe(false);
  });

  test('does not flag a different professional with no shared resource', () => {
    const r = real({ professional_user_id: '10' });
    const otherPro = virtual({ professional_user_id: '99' });
    flagRealConflictsWithVirtuals([r], [otherPro], NOW);
    expect(r.in_conflict).toBe(false);
  });

  test('flags on a resource clash even when the professional differs', () => {
    const r = real({ professional_user_id: '10', resource_id: '42' });
    const sharedRoom = virtual({ professional_user_id: '99', resource_id: '42' });
    flagRealConflictsWithVirtuals([r], [sharedRoom], NOW);
    expect(r.in_conflict).toBe(true);
  });

  test('leaves a staff-ignored row unflagged', () => {
    const r = real({ conflict_ignored: true });
    flagRealConflictsWithVirtuals([r], [virtual()], NOW);
    expect(r.in_conflict).toBe(false);
  });

  test('leaves a past row unflagged', () => {
    const r = real({
      starts_at: new Date(NOW - HOUR),
      ends_at: new Date(NOW - HOUR + 30 * 60_000),
    });
    const past = virtual({ starts_at: new Date(NOW - HOUR).toISOString() });
    flagRealConflictsWithVirtuals([r], [past], NOW);
    expect(r.in_conflict).toBe(false);
  });

  test('leaves a terminal-state row unflagged', () => {
    const r = real({ state: 'completed' });
    flagRealConflictsWithVirtuals([r], [virtual()], NOW);
    expect(r.in_conflict).toBe(false);
  });

  test('a non-conflicting virtual never flags its overlapping real row', () => {
    const r = real();
    flagRealConflictsWithVirtuals([r], [virtual({ in_conflict: false })], NOW);
    expect(r.in_conflict).toBe(false);
  });
});
