import type { EventInput } from '@fullcalendar/core';
import { detectOverlap } from '@shared/ssot/domain';
import type { Weekday } from '@shared/ssot/domain';

// A known Monday; the template is dateless, so any fixed Monday works as the render anchor.
export const TEMPLATE_BASE_MONDAY = '2024-01-01';
// Display order (Mon-first). The SSOT `WEEKDAYS` is Sun-first; this drives the fixed-week columns.
export const MON_FIRST_WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export type TemplateBlock = {
  id: string;
  professional_user_id: string;
  weekday: Weekday;
  start_time: string;
  end_time: string;
};

function pad(n: number): string { return String(n).padStart(2, '0'); }

export function weekdayToDate(weekday: Weekday): string {
  const offset = MON_FIRST_WEEKDAYS.indexOf(weekday);
  const [y, m, d] = TEMPLATE_BASE_MONDAY.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + offset));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function dateToWeekday(dateISO: string): Weekday {
  const [y, m, d] = dateISO.split('-').map(Number);
  const [by, bm, bd] = TEMPLATE_BASE_MONDAY.split('-').map(Number);
  const days = Math.round(
    (Date.UTC(y, m - 1, d) - Date.UTC(by, bm - 1, bd)) / 86_400_000,
  );
  return MON_FIRST_WEEKDAYS[((days % 7) + 7) % 7];
}

export function blockToEvent(b: TemplateBlock): EventInput {
  const date = weekdayToDate(b.weekday);
  // The API serialises TIME as 'HH:MM:SS'; a seconds-bearing value would build the malformed
  // 'HH:MM:SS:00' datetime FullCalendar silently drops. Take HH:MM regardless of what arrives.
  const hhmm = (t: string) => t.slice(0, 5);
  return {
    id: b.id,
    start: `${date}T${hhmm(b.start_time)}:00`,
    end: `${date}T${hhmm(b.end_time)}:00`,
    extendedProps: { block: b },
  };
}

// FullCalendar hands back ISO datetimes like '2024-01-02T09:00:00' (local, no tz suffix here).
export function eventToWeekdayTimes(startISO: string, endISO: string): { weekday: Weekday; start_time: string; end_time: string } {
  const [dpart, tpart] = startISO.split('T');
  const [, etpart] = endISO.split('T');
  return {
    weekday: dateToWeekday(dpart),
    start_time: tpart.slice(0, 5),
    end_time: etpart.slice(0, 5),
  };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(mins: number): string {
  return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
}

// A dragged edge snaps to another block's edge when it lands within this many minutes; otherwise it
// moves per-minute. It's a magnet to real boundaries, not a coarse grid.
export const SNAP_THRESHOLD_MINUTES = 10;

// Every start/end edge of the other blocks (any weekday) — the boundaries a dragged edge can snap onto,
// so blocks line up with each other (e.g. every afternoon block aligns to a shared 14:00 start), not
// just with the block immediately adjacent on the same day.
export function otherBlockEdges(blocks: TemplateBlock[], ignoreId?: string): number[] {
  return blocks
    .filter((b) => b.id !== ignoreId)
    .flatMap((b) => [toMinutes(b.start_time), toMinutes(b.end_time)]);
}

export function nearestEdgeWithin(value: number, edges: number[]): number | null {
  let best: number | null = null;
  let bestDist = SNAP_THRESHOLD_MINUTES + 1;
  for (const e of edges) {
    const dist = Math.abs(e - value);
    if (dist <= SNAP_THRESHOLD_MINUTES && dist < bestDist) { best = e; bestDist = dist; }
  }
  return best;
}

export function snapMinuteToEdges(value: number, edges: number[]): number {
  return nearestEdgeWithin(value, edges) ?? Math.round(value);
}

// Snap a candidate block's start and end each onto the nearest other-block edge. Used by drag-to-create
// on release; the live custom drag snaps through the placement helpers (which also clamp for overlap).
export function snapToNeighbors(
  candidate: WeekdayTimes,
  others: TemplateBlock[],
  ignoreId?: string,
): WeekdayTimes {
  const edges = otherBlockEdges(others, ignoreId);
  return {
    weekday: candidate.weekday,
    start_time: fromMinutes(snapMinuteToEdges(toMinutes(candidate.start_time), edges)),
    end_time: fromMinutes(snapMinuteToEdges(toMinutes(candidate.end_time), edges)),
  };
}

export function overlaps(
  candidate: { weekday: Weekday; start_time: string; end_time: string },
  others: TemplateBlock[],
  ignoreId?: string,
): boolean {
  const a = { startsAt: toMinutes(candidate.start_time), endsAt: toMinutes(candidate.end_time) };
  return others.some((o) =>
    o.id !== ignoreId &&
    o.weekday === candidate.weekday &&
    detectOverlap(a, { startsAt: toMinutes(o.start_time), endsAt: toMinutes(o.end_time) }),
  );
}

export type WeekdayTimes = { weekday: Weekday; start_time: string; end_time: string };

export type DecideResult =
  | { ok: true; body: WeekdayTimes }
  | { ok: false; reason: 'invalid' | 'overlap' };

// A drag-select or drop/resize that lands the event on a different calendar date than it started
// (crosses midnight) can't be expressed as a single weekday+HH:MM block — reject before converting.
function crossesDay(startStr: string, endStr: string): boolean {
  return startStr.slice(0, 10) !== endStr.slice(0, 10);
}

export function decideCreate(
  candidate: { startStr: string; endStr: string },
  blocks: TemplateBlock[],
): DecideResult {
  if (crossesDay(candidate.startStr, candidate.endStr)) return { ok: false, reason: 'invalid' };
  const times = snapToNeighbors(eventToWeekdayTimes(candidate.startStr, candidate.endStr), blocks);
  if (times.start_time >= times.end_time) return { ok: false, reason: 'invalid' };
  if (overlaps(times, blocks)) return { ok: false, reason: 'overlap' };
  return { ok: true, body: times };
}

// Same decision as decideCreate, but ignores the moved/resized block's own row when checking overlap.
export function decideUpdate(
  candidate: { startStr: string; endStr: string },
  blocks: TemplateBlock[],
  ignoreId: string,
): DecideResult {
  // No re-snap here: the live custom drag already snapped and clamped, so persist exactly what the
  // ghost showed. This is just the safety net (same-day, valid range, no overlap).
  if (crossesDay(candidate.startStr, candidate.endStr)) return { ok: false, reason: 'invalid' };
  const times = eventToWeekdayTimes(candidate.startStr, candidate.endStr);
  if (times.start_time >= times.end_time) return { ok: false, reason: 'invalid' };
  if (overlaps(times, blocks, ignoreId)) return { ok: false, reason: 'overlap' };
  return { ok: true, body: times };
}
