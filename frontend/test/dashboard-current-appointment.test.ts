import { describe, it, expect } from 'vitest';
import {
  isCurrent,
  canSettle,
  transitionFor,
  showsCurrentCard,
} from '@/views/staff/dashboard-current';

const START = '2026-07-08T13:00:00.000Z';
const appt = { state: 'scheduled', starts_at: START };
const at = (iso: string) => new Date(iso);

describe('dashboard current-appointment window', () => {
  it('is current from 5 min before start', () => {
    expect(isCurrent(appt, at('2026-07-08T12:55:00.000Z'))).toBe(true); // start - 5
    expect(isCurrent(appt, at('2026-07-08T13:25:00.000Z'))).toBe(true); // mid
  });

  it('is not current before start - 5 min', () => {
    expect(isCurrent(appt, at('2026-07-08T12:54:00.000Z'))).toBe(false);
  });

  it('never expires while unresolved — hours or days after the end', () => {
    expect(isCurrent(appt, at('2026-07-08T18:00:00.000Z'))).toBe(true); // same day, long after
    expect(isCurrent(appt, at('2026-07-11T09:00:00.000Z'))).toBe(true); // days later
  });

  it('is never current unless scheduled', () => {
    const mid = at('2026-07-08T13:25:00.000Z');
    expect(isCurrent({ ...appt, state: 'completed' }, mid)).toBe(false);
    expect(isCurrent({ ...appt, state: 'no_show' }, mid)).toBe(false);
    expect(isCurrent({ ...appt, state: 'requested' }, mid)).toBe(false);
  });

  it('cannot settle before the turno starts, but can once it has', () => {
    expect(canSettle(appt, at('2026-07-08T12:57:00.000Z'))).toBe(false); // pre-start lead
    expect(canSettle(appt, at('2026-07-08T13:00:00.000Z'))).toBe(true);
  });

  it('maps paid/unpaid to completed and absent to no_show', () => {
    expect(transitionFor('paid')).toBe('completed');
    expect(transitionFor('unpaid')).toBe('completed');
    expect(transitionFor('absent')).toBe('no_show');
  });
});

describe('dashboard current-appointment visibility', () => {
  // professional_user_id arrives on the wire as a string (BIGINT); the auth user's id is a number.
  const forPro7 = { professional_user_id: '7' };

  it('shows for the appointment’s own professional only', () => {
    expect(showsCurrentCard({ id: 7, role: 'Professional' }, forPro7)).toBe(true);
    expect(showsCurrentCard({ id: 8, role: 'Professional' }, forPro7)).toBe(false);
  });

  it('shows for receptionists (list is server-scoped to granted calendars)', () => {
    expect(showsCurrentCard({ id: 3, role: 'Receptionist' }, forPro7)).toBe(true);
  });

  it('never shows for admins, clients, or logged-out users', () => {
    expect(showsCurrentCard({ id: 7, role: 'Admin' }, forPro7)).toBe(false);
    expect(showsCurrentCard({ id: 7, role: 'Client' }, forPro7)).toBe(false);
    expect(showsCurrentCard(null, forPro7)).toBe(false);
  });
});
