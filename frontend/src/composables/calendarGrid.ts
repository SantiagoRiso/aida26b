// Pure geometry for the calendar drag grid. No Vue / FullCalendar deps so it unit-tests in isolation.

import { mergeIntervals, toMinutes } from '@shared/ssot/domain';

export function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a;
}

export function gcdAll(values: number[]): number {
  return values.reduce((g, v) => gcd(g, v), 0);
}

// Largest snap step that lands FullCalendar's uniform grid (origin + n·step) on every real slot
// start AND cleanly subdivides the visual row (slotMinutes). Empty slots → the row size itself.
export function computeSnapMinutes(
  slotStartsMinutes: number[],
  originMinutes: number,
  slotMinutes: number,
): number {
  const offsets = slotStartsMinutes.map((s) => Math.abs(s - originMinutes));
  const g = gcdAll([...offsets, slotMinutes]);
  return g > 0 ? g : slotMinutes;
}

// Gaps within [min, max] not covered by the given intervals — the "closed/blocked" spans
// complementary to a resource's free availability windows. Input need not be pre-merged.
export function complementIntervals(
  intervals: { start: number; end: number }[],
  min: number,
  max: number,
): { start: number; end: number }[] {
  const merged = mergeIntervals(intervals);
  const out: { start: number; end: number }[] = [];
  let cursor = min;
  for (const w of merged) {
    const s = Math.max(w.start, min);
    if (s > cursor) out.push({ start: cursor, end: s });
    cursor = Math.max(cursor, Math.min(w.end, max));
  }
  if (cursor < max) out.push({ start: cursor, end: max });
  return out;
}

// Every start (HH:MM) where the appointment's full duration fits, tiling each free window back-to-back
// by the duration. Service-less availability hands us contiguous free WINDOWS (not tiled slots), so
// returning just the window starts would offer a single drop position on an open day. Bookings are
// grid-aligned, so free-window edges are too — tiling from the window start reproduces the schedule's
// slot grid within free time.
export function tileFreeWindows(
  freeWindows: { start: string; end: string }[],
  durationMinutes: number,
): string[] {
  if (durationMinutes <= 0) return [];
  const merged = mergeIntervals(
    freeWindows.map((s) => ({ start: toMinutes(s.start), end: toMinutes(s.end) })),
  );
  const pad = (n: number) => String(n).padStart(2, '0');
  const out: string[] = [];
  for (const w of merged) {
    for (let s = w.start; s + durationMinutes <= w.end; s += durationMinutes) {
      out.push(`${pad(Math.floor(s / 60))}:${pad(s % 60)}`);
    }
  }
  return out;
}

// Slot-start lattice + finest slot length from a day's free slots — the grid the calendar snaps
// to and the read-only day view aligns its rows on. Empty slots → nulls (no lattice).
export function latticeFromFreeSlots(
  slots: { start: string; end: string }[],
): { starts: number[] | null; minutes: number | null } {
  const set = new Set<number>();
  let minLen = Infinity;
  for (const s of slots) {
    set.add(toMinutes(s.start));
    minLen = Math.min(minLen, toMinutes(s.end) - toMinutes(s.start));
  }
  return {
    starts: set.size > 0 ? [...set].sort((a, b) => a - b) : null,
    minutes: Number.isFinite(minLen) ? minLen : null,
  };
}

function minutesToHms(min: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const clamped = Math.max(0, Math.min(min, 24 * 60));
  return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}:00`;
}

export interface SnapConfig {
  slotMinTime: string;
  slotDuration: string;
  slotLabelInterval: string;
  snapDuration: string;
}

// FullCalendar timegrid options that make the drag snap onto a professional's real slots. With
// slot starts, the origin is phase-aligned to their lattice and the snap is the GCD step (so grid
// rows and snap both land on real slots). `fine` (sobreturno mode) forces a 5-min snap. Without
// slots (mixed view), a generic 30-min grid with 5-min snapping. Shared by the reactive options
// path and the synchronous pointerdown path so both produce identical geometry.
export function snapConfig(
  slotStartsMinutes: number[] | null,
  slotMinutes: number | null,
  floorMinutes: number,
  fine: boolean,
): SnapConfig {
  if (!(slotStartsMinutes && slotStartsMinutes.length > 0)) {
    return { slotMinTime: minutesToHms(floorMinutes), slotDuration: '00:30:00', slotLabelInterval: '01:00:00', snapDuration: '00:05:00' };
  }
  const gran = slotMinutes ?? 30;
  const anchor = Math.min(...slotStartsMinutes);
  const rem = (((floorMinutes - anchor) % gran) + gran) % gran;
  const origin = floorMinutes - rem;
  const snap = fine ? 5 : computeSnapMinutes(slotStartsMinutes, origin, gran);
  return {
    slotMinTime: minutesToHms(origin),
    slotDuration: minutesToHms(gran),
    // Label every row: a 60-min interval doesn't divide a 50-min lattice, leaving most rows blank.
    slotLabelInterval: minutesToHms(gran),
    snapDuration: minutesToHms(snap),
  };
}

// Where a live drag should land. Movement is always free at 5-minute precision; coarse mode only
// magnetizes to a real slot when the pointer is close enough. This keeps the block under the pointer
// while availability is loading and avoids jumps across large gaps in a schedule.
export function snapDragMinutes(
  targetMinutes: number,
  validStartsMinutes: number[],
  fine: boolean,
  thresholdMinutes = 20,
): number {
  const free = Math.round(targetMinutes / 5) * 5;
  if (fine) return free;
  return resolveDrop(validStartsMinutes, targetMinutes, thresholdMinutes) ?? free;
}

// Same-day rule: an appointment must start and finish on the same calendar day. Midnight (24:00)
// is the inclusive edge, so only a total strictly past 24:00 overflows the day. Also treats a
// non-positive duration as invalid (e.g. a resize whose end wrapped to the next day).
export function exceedsEndOfDay(startMinutes: number, durationMinutes: number): boolean {
  return durationMinutes <= 0 || startMinutes + durationMinutes > 24 * 60;
}

// Nearest valid start within threshold, or null to refuse the drop (no silent teleport).
export function resolveDrop(
  validStartsMinutes: number[],
  droppedMinutes: number,
  thresholdMinutes: number,
): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const v of validStartsMinutes) {
    const d = Math.abs(v - droppedMinutes);
    if (d < bestDist) {
      bestDist = d;
      best = v;
    }
  }
  return best !== null && bestDist <= thresholdMinutes ? best : null;
}
