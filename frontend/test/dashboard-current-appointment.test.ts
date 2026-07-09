import { describe, it, expect } from 'vitest';

// Mirrors DashboardView's current-appointment window (#1): the turno is "current" from 5 minutes
// before it starts until 5 minutes after it ends, and only while still scheduled.
const WINDOW_MS = 5 * 60 * 1000;
interface Appt { state: string; starts_at: string; ends_at: string }

function isCurrent(appt: Appt, at: Date): boolean {
  if (appt.state !== 'scheduled') return false;
  const start = new Date(appt.starts_at).getTime();
  const end = new Date(appt.ends_at).getTime();
  const t = at.getTime();
  return t >= start - WINDOW_MS && t <= end + WINDOW_MS;
}

// Attendance can't be registered before the turno starts.
function canSettle(appt: Appt, at: Date): boolean {
  return at.getTime() >= new Date(appt.starts_at).getTime();
}

// The action → state transition the card requests.
function transitionFor(action: 'paid' | 'unpaid' | 'absent'): string {
  return action === 'absent' ? 'no_show' : 'completed';
}

const START = '2026-07-08T13:00:00.000Z';
const END = '2026-07-08T13:50:00.000Z';
const appt: Appt = { state: 'scheduled', starts_at: START, ends_at: END };
const at = (iso: string) => new Date(iso);

describe('dashboard current-appointment window', () => {
  it('is current from 5 min before start to 5 min after end', () => {
    expect(isCurrent(appt, at('2026-07-08T12:55:00.000Z'))).toBe(true); // start - 5
    expect(isCurrent(appt, at('2026-07-08T13:25:00.000Z'))).toBe(true); // mid
    expect(isCurrent(appt, at('2026-07-08T13:55:00.000Z'))).toBe(true); // end + 5
  });

  it('is not current outside the ±5-min window', () => {
    expect(isCurrent(appt, at('2026-07-08T12:54:00.000Z'))).toBe(false); // before start - 5
    expect(isCurrent(appt, at('2026-07-08T13:56:00.000Z'))).toBe(false); // after end + 5
  });

  it('is never current unless scheduled', () => {
    expect(isCurrent({ ...appt, state: 'completed' }, at('2026-07-08T13:25:00.000Z'))).toBe(false);
    expect(isCurrent({ ...appt, state: 'requested' }, at('2026-07-08T13:25:00.000Z'))).toBe(false);
  });

  it('cannot settle before the turno starts, but can once it has', () => {
    expect(canSettle(appt, at('2026-07-08T12:57:00.000Z'))).toBe(false); // pre-start part of window
    expect(canSettle(appt, at('2026-07-08T13:00:00.000Z'))).toBe(true);
  });

  it('maps paid/unpaid to completed and absent to no_show', () => {
    expect(transitionFor('paid')).toBe('completed');
    expect(transitionFor('unpaid')).toBe('completed');
    expect(transitionFor('absent')).toBe('no_show');
  });
});
