import { describe, it, expect } from 'vitest';
import { roleAllowedFor } from '@/router/access';
import type { Role } from '@shared/types/types';

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

// Mirrors CalendarView.handleSelect's month-view gate (#11): a full day is blocked unless
// sobreturno mode is on, which deliberately books outside published availability.
function monthClickBlocked(sobreturno: boolean, view: string, dayHasAvailability: boolean | undefined): boolean {
  return !sobreturno && view === 'dayGridMonth' && dayHasAvailability === false;
}

describe('month-view sobreturno booking gate', () => {
  it('blocks a full day in month view when sobreturno is off', () => {
    expect(monthClickBlocked(false, 'dayGridMonth', false)).toBe(true);
  });

  it('allows a full day in month view when sobreturno is on', () => {
    expect(monthClickBlocked(true, 'dayGridMonth', false)).toBe(false);
  });

  it('never blocks a day that has availability', () => {
    expect(monthClickBlocked(false, 'dayGridMonth', true)).toBe(false);
  });

  it('does not apply the month gate in other views', () => {
    expect(monthClickBlocked(false, 'timeGridWeek', false)).toBe(false);
  });
});
