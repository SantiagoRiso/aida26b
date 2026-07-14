import { describe, it, expect } from 'vitest';
import { roleAllowedFor } from '@/router/access';
import type { Role } from '@shared/types/roles';

// Mirrors ProfessionalDetail's action gating (#9): Admin/Receptionist manage any professional's
// profile; a Professional may edit only their own; only an Admin can deactivate.
function canEditProfile(role: Role, isSelf: boolean): boolean {
  return roleAllowedFor(['Admin', 'Receptionist'], role) || (role === 'Professional' && isSelf);
}
function canDeactivate(role: Role): boolean {
  return roleAllowedFor(['Admin'], role);
}

describe('ProfessionalDetail action gating', () => {
  it('Admin can edit and deactivate any professional', () => {
    expect(canEditProfile('Admin', false)).toBe(true);
    expect(canDeactivate('Admin')).toBe(true);
  });

  it('Receptionist can edit but not deactivate', () => {
    expect(canEditProfile('Receptionist', false)).toBe(true);
    expect(canDeactivate('Receptionist')).toBe(false);
  });

  it('a Professional can edit only their own profile, never deactivate', () => {
    expect(canEditProfile('Professional', true)).toBe(true);
    expect(canEditProfile('Professional', false)).toBe(false);
    expect(canDeactivate('Professional')).toBe(false);
  });
});

// Mirrors CalendarView.handleSelect's month-view gate: a day without free slots is blocked
// unless sobreturno mode is on, and the block message says WHY — fully booked vs not worked.
type DayAvailability = 'free' | 'full' | 'closed';
function monthClickVerdict(
  sobreturno: boolean,
  view: string,
  day: DayAvailability | undefined,
): 'allowed' | 'dayFullyBooked' | 'noSlotsThatDay' {
  if (sobreturno || view !== 'dayGridMonth' || day === 'free' || day === undefined) return 'allowed';
  return day === 'full' ? 'dayFullyBooked' : 'noSlotsThatDay';
}

describe('month-view sobreturno booking gate', () => {
  it('blocks a fully booked day with the fully-booked message', () => {
    expect(monthClickVerdict(false, 'dayGridMonth', 'full')).toBe('dayFullyBooked');
  });

  it('blocks a not-worked day with the not-worked message', () => {
    expect(monthClickVerdict(false, 'dayGridMonth', 'closed')).toBe('noSlotsThatDay');
  });

  it('allows any day when sobreturno is on', () => {
    expect(monthClickVerdict(true, 'dayGridMonth', 'full')).toBe('allowed');
    expect(monthClickVerdict(true, 'dayGridMonth', 'closed')).toBe('allowed');
  });

  it('never blocks a day with free slots', () => {
    expect(monthClickVerdict(false, 'dayGridMonth', 'free')).toBe('allowed');
  });

  it('does not apply the month gate in other views', () => {
    expect(monthClickVerdict(false, 'timeGridWeek', 'full')).toBe('allowed');
  });
});
