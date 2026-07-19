import { HHMM_PATTERN, BUSINESS_TZ, ARGENTINA_OFFSET_MS } from '../../shared/src/ssot/domain/availability';

// Shared by the booking and scheduling paths so the two cannot disagree on timezone, formats,
// or the same-day rule. The timezone fact itself lives in the shared SSOT.
export { BUSINESS_TZ };

export const HHMM_RE = new RegExp(HHMM_PATTERN);
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DATE_OR_ISO_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?([+-]\d{2}:?\d{2})?)?$/;

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

export function buildStartsAt(date: string, start: string): string {
  return `${date} ${start}:00 ${BUSINESS_TZ}`;
}

// A list filter's date_from/date_to may already be a bare date or a full ISO instant; virtual
// occurrence expansion always needs a plain calendar date in BUSINESS_TZ.
export function toBusinessDate(input: string): string {
  return DATE_RE.test(input) ? input : new Date(input).toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });
}

// Same date+HH:MM -> business-tz instant as buildStartsAt, but rendered as a wire-ready ISO string
// (Argentina has no DST, so the fixed offset is exact) rather than a Postgres timestamptz literal —
// a virtual occurrence has no appointments row to construct via a SQL insert param.
export function businessDateTimeToISO(date: string, start: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = start.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm, 0) - ARGENTINA_OFFSET_MS).toISOString();
}

// Shift an ISO date by whole days via local midnight, so a timezone offset can't drift the day.
export function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const nd = new Date(y, m - 1, d + days);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${nd.getFullYear()}-${p(nd.getMonth() + 1)}-${p(nd.getDate())}`;
}
