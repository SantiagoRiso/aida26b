// Argentina-only (UTC-3, no DST). Appointment starts_at/ends_at are TIMESTAMPTZ; slots and
// schedules are local wall-clock HH:MM. Shared by the booking and scheduling paths so the two
// cannot disagree on timezone, formats, or the same-day rule.
export const BUSINESS_TZ = 'America/Argentina/Buenos_Aires';

export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// An appointment starts and ends on the same day — reject rather than roll HH:MM past 24:00.
export function crossesMidnight(start: string, durationMinutes: number): boolean {
  const startMin = Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5));
  return startMin + durationMinutes > 24 * 60;
}

// TIMESTAMPTZ literal for a local wall-clock date + HH:MM in the business timezone.
export function buildStartsAt(date: string, start: string): string {
  return `${date} ${start}:00 ${BUSINESS_TZ}`;
}
