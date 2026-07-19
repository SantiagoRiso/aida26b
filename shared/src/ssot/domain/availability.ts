// Weekday vocabulary and the availability/time-math library: availability is computed, never
// stored (weekly blocks − exceptions − booked).

import type { LocalizedText } from '../../types/types';

// Argentina-only product: every wall-clock time is this zone. Appointment starts_at/ends_at are
// TIMESTAMPTZ; slots and schedules are local HH:MM.
export const BUSINESS_TZ = 'America/Argentina/Buenos_Aires';

// BUSINESS_TZ as a fixed offset — Argentina observes no DST, so UTC-3 holds all year. Paired with
// BUSINESS_TZ: a drift test recomputes the zone's real offset via Intl and fails if they diverge
// (e.g. Argentina re-adopting DST).
export const ARGENTINA_OFFSET_MS = -3 * 60 * 60 * 1000;

// Shared by every 'HH:MM' 24h column (block/exception start and end times).
export const HHMM_PATTERN = '^([01]\\d|2[0-3]):[0-5]\\d$';
export const HHMM_PATTERN_MESSAGE = 'must be HH:MM';

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

// eslint-disable-next-line no-restricted-syntax -- Runtime guard validates request and database boundary values.
export function isWeekday(value: unknown): value is Weekday {
  return typeof value === 'string' && WEEKDAYS.some((weekday) => weekday === value);
}

const WEEKDAY_LABELS: Record<Weekday, LocalizedText> = {
  mon: { es: 'Lunes', en: 'Monday' },
  tue: { es: 'Martes', en: 'Tuesday' },
  wed: { es: 'Miércoles', en: 'Wednesday' },
  thu: { es: 'Jueves', en: 'Thursday' },
  fri: { es: 'Viernes', en: 'Friday' },
  sat: { es: 'Sábado', en: 'Saturday' },
  sun: { es: 'Domingo', en: 'Sunday' },
};
// Displayed Mon..Sun; WEEKDAYS itself starts Sun to match JS Date#getUTCDay().
export const WEEKDAY_OPTIONS = [...WEEKDAYS.slice(1), WEEKDAYS[0]].map((value) => ({
  value,
  label: WEEKDAY_LABELS[value],
}));

// 'HH:MM' 24h, end-exclusive. granularity_minutes is an optional per-interval slot size
// some callers carry; free-window callers omit it.
export type TimeInterval = { start: string; end: string; granularity_minutes?: number };

export type ScheduleExceptionInput = {
  is_unavailable: boolean;
  start_time?: string | null;
  end_time?: string | null;
  // Slot size for a changed-hours "available" exception; null for full-day/blocked.
  granularity_minutes?: number | null;
};

type MinuteInterval = { start: number; end: number };

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

export function toHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function mergeIntervals(intervals: MinuteInterval[]): MinuteInterval[] {
  const sorted = [...intervals].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: MinuteInterval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

function subtractIntervals(base: MinuteInterval[], blocks: MinuteInterval[]): MinuteInterval[] {
  const merged = mergeIntervals(blocks);
  let current = mergeIntervals(base);
  for (const block of merged) {
    const next: MinuteInterval[] = [];
    for (const iv of current) {
      if (block.end <= iv.start || block.start >= iv.end) {
        next.push(iv);
        continue;
      }
      if (block.start > iv.start) next.push({ start: iv.start, end: block.start });
      if (block.end < iv.end) next.push({ start: block.end, end: iv.end });
    }
    current = next;
  }
  return current;
}

export function weekdayOf(date: string): Weekday {
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function detectOverlap(
  a: { startsAt: number; endsAt: number },
  b: { startsAt: number; endsAt: number },
): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

// A working block already resolved for one chosen service: slot_minutes is that service's
// effective duration inside this block (per-block override else the service default). The
// caller resolves slot_minutes; this function only tiles.
export type ServiceBlock = { start: string; end: string; slot_minutes: number };

// Working windows for one date after exceptions: blocks ∪ extra-hours − blocked-hours, merged.
// Empty on a full-day off. The service-independent base the slot tiler and the free-window view
// both build on.
function availableMinuteWindows(
  blocks: { start: string; end: string }[],
  exceptions: ScheduleExceptionInput[],
): MinuteInterval[] {
  if (exceptions.some((e) => e.is_unavailable && !e.start_time && !e.end_time)) return [];
  const base = mergeIntervals(blocks.map((b) => ({ start: toMinutes(b.start), end: toMinutes(b.end) })));
  const additions: MinuteInterval[] = [];
  const blockOffs: MinuteInterval[] = [];
  for (const e of exceptions) {
    if (!e.start_time || !e.end_time) continue;
    const iv = { start: toMinutes(e.start_time), end: toMinutes(e.end_time) };
    if (iv.end <= iv.start) continue;
    (e.is_unavailable ? blockOffs : additions).push(iv);
  }
  return subtractIntervals(mergeIntervals([...base, ...additions]), blockOffs);
}

// Service-independent free windows for one owner on one date: the working windows (blocks ±
// exceptions) with booked spans removed, as contiguous intervals — NOT tiled into service-sized
// slots. Feeds the staff calendar's availability shading and snap lattice, which have no chosen
// service (a professional's schedule is service-agnostic; slot sizing only matters for booking).
export function computeFreeWindows(input: {
  blocks: { start: string; end: string }[];
  exceptions?: ScheduleExceptionInput[];
  booked?: TimeInterval[];
}): TimeInterval[] {
  const { blocks, exceptions = [], booked = [] } = input;
  const available = availableMinuteWindows(blocks, exceptions);
  const bookedMin = booked.map((iv) => ({ start: toMinutes(iv.start), end: toMinutes(iv.end) }));
  return subtractIntervals(available, bookedMin).map((iv) => ({ start: toHHMM(iv.start), end: toHHMM(iv.end) }));
}

// Service-driven slots for one owner on one date: each block chopped into back-to-back slots of
// its own slot_minutes (measured from block start), kept only when the slot lies fully inside the
// available window (blocks ± exceptions) and overlaps no booked interval. End-exclusive. The slot
// size comes from the chosen service, not a fixed per-block grid.
export function computeServiceSlots(input: {
  blocks: ServiceBlock[];
  exceptions?: ScheduleExceptionInput[];
  booked?: TimeInterval[];
}): TimeInterval[] {
  const { blocks, exceptions = [], booked = [] } = input;
  const available = availableMinuteWindows(blocks, exceptions);
  if (available.length === 0) return [];

  const bookedMin = booked.map((iv) => ({ start: toMinutes(iv.start), end: toMinutes(iv.end) }));
  const seen = new Set<string>();
  const slots: MinuteInterval[] = [];
  for (const b of blocks) {
    const gran = b.slot_minutes;
    if (!Number.isInteger(gran) || gran <= 0) continue;
    for (let s = toMinutes(b.start); s + gran <= toMinutes(b.end); s += gran) {
      const slot = { start: s, end: s + gran };
      if (!available.some((iv) => iv.start <= slot.start && slot.end <= iv.end)) continue;
      const clash = bookedMin.some((k) =>
        detectOverlap({ startsAt: slot.start, endsAt: slot.end }, { startsAt: k.start, endsAt: k.end }),
      );
      if (clash) continue;
      const key = `${slot.start}-${slot.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      slots.push(slot);
    }
  }
  slots.sort((a, b) => a.start - b.start);
  return slots.map((iv) => ({ start: toHHMM(iv.start), end: toHHMM(iv.end) }));
}
