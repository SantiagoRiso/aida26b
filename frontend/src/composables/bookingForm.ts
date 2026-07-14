// Shared helpers for the two booking forms — the staff AppointmentForm and the client RequestFlow.
// Both step a date, derive a slot's duration, and scope services to a professional's offerings;
// these keep that logic in one place instead of each form reimplementing it.

import { toMinutes } from '@shared/ssot/domain/availability';

const pad = (n: number): string => String(n).padStart(2, '0');

// A Date → local 'YYYY-MM-DD'. Uses the browser's local day: new Date('YYYY-MM-DD') parses as UTC and
// would drift the day across a timezone offset, so date math must go through a local Date.
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Step a 'YYYY-MM-DD' by whole days via local midnight (see isoDate). Callers apply their own clamps.
export function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return isoDate(new Date(y, m - 1, d + days));
}

export function intervalMinutes(start: string, end: string): number {
  return toMinutes(end) - toMinutes(start);
}

// The set of service ids a professional offers, or null when there is no professional selected or no
// mapping — null means "no restriction" (fall back to every service), matching both forms' behavior.
export function offeredServiceIds(
  professionalServices: { professional_user_id: string; service_id: string }[],
  professionalUserId: string | null,
): Set<string> | null {
  if (!professionalUserId) return null;
  const set = new Set<string>();
  for (const ps of professionalServices) {
    if (String(ps.professional_user_id) === professionalUserId) set.add(String(ps.service_id));
  }
  return set.size > 0 ? set : null;
}
