// Pure math for the availability background layers (past wash, occupied/requested washes,
// closed-hours hatch, dotted slot outlines). No Vue deps so it unit-tests in isolation; both the
// staff calendar and the request-detail day view render from these so they can never disagree.
import type { EventInput } from '@fullcalendar/core';
import { WEEKDAYS, toHHMM, mergeIntervals } from '@shared/ssot/domain/availability';
import { VOID_APPOINTMENT_STATES } from '@shared/ssot/domain/appointment-lifecycle';
import { complementIntervals } from '@/composables/calendarGrid';
import type { ProfessionalBlock } from '@/composables/useProfessionalBlocks';

export interface MinuteInterval {
  start: number;
  end: number;
}

// Requested (a client's pending request) is kept apart from confirmed occupancy so the calendar
// background can shade them differently.
export interface BookedDay {
  occupied: MinuteInterval[];
  requested: MinuteInterval[];
}

export const DAY_END_MINUTES = 24 * 60;

const VOID_STATES = new Set<string>(VOID_APPOINTMENT_STATES);

export function dayISO(base: Date, offsetDays: number): string {
  const d = new Date(base.getTime() + offsetDays * 86400000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function bgEvent(date: string, startMin: number, endMin: number, cls: string): EventInput {
  return {
    start: `${date}T${toHHMM(startMin)}:00`,
    end: `${date}T${toHHMM(endMin)}:00`,
    display: 'background',
    classNames: [cls],
  };
}

// Occupied vs requested minute-intervals keyed by local start date. Void states (canceled/rejected)
// hold no time.
export function bookedIntervalsByDate(
  appts: readonly { starts_at: string; ends_at: string; state: string }[],
): Map<string, BookedDay> {
  const map = new Map<string, BookedDay>();
  for (const a of appts) {
    if (VOID_STATES.has(a.state)) continue;
    const s = new Date(a.starts_at);
    const e = new Date(a.ends_at);
    const start = s.getHours() * 60 + s.getMinutes();
    let end = e.getHours() * 60 + e.getMinutes();
    if (end <= start) end = DAY_END_MINUTES; // ends at/after midnight
    const key = dayISO(s, 0);
    const day = map.get(key) ?? { occupied: [], requested: [] };
    (a.state === 'requested' ? day.requested : day.occupied).push({ start, end });
    map.set(key, day);
  }
  return map;
}

// One day's occupancy washes plus the closed-hours hatch, all suppressed below `floorMin` (past
// time can't be booked, so it reads plain).
export function availabilityWashEvents(
  date: string,
  freeSlots: readonly MinuteInterval[],
  booked: BookedDay,
  floorMin: number,
): EventInput[] {
  const out: EventInput[] = [];
  const clip = (iv: MinuteInterval) => ({ start: Math.max(iv.start, floorMin), end: iv.end });
  // Each occupancy kind gets its own background wash so the three read apart at the calendar level:
  // occupied (confirmed) and requested (a client's pending request) are distinct tints…
  for (const iv of mergeIntervals(booked.occupied.map(clip))) out.push(bgEvent(date, iv.start, iv.end, 'fc-slot-occupied'));
  for (const iv of mergeIntervals(booked.requested.map(clip))) out.push(bgEvent(date, iv.start, iv.end, 'fc-slot-requested-bg'));
  // …and never-available time (off-hours / day off) — neither free nor booked — is the grey hatch.
  const working = mergeIntervals([...freeSlots, ...booked.occupied, ...booked.requested]);
  for (const g of complementIntervals(working, floorMin, DAY_END_MINUTES)) out.push(bgEvent(date, g.start, g.end, 'fc-res-closed'));
  return out;
}

// Flat grey wash over time that has elapsed: the whole column for a past day, up to `todayFloorMin`
// for today (the caller decides that boundary — exact now, or the current cell's start so the cell
// isn't split), nothing for a future day.
export function pastWashEvent(date: string, today: string, todayFloorMin: number): EventInput | null {
  if (date < today) {
    const nextDay = dayISO(new Date(`${date}T00:00:00`), 1);
    return { start: `${date}T00:00:00`, end: `${nextDay}T00:00:00`, display: 'background', classNames: ['fc-slot-past'] };
  }
  if (date === today && todayFloorMin > 0) return bgEvent(date, 0, todayFloorMin, 'fc-slot-past');
  return null;
}

// One dotted outline per schedule slot on `date`: each block tiled by its own slot size, trailing
// partial dropped (matching the availability engine). `bookable` gates which slots still advertise —
// callers encode their own rule (availability windows vs. overlap against booked intervals).
export function slotOutlineEventsForDay(
  date: string,
  blocks: readonly ProfessionalBlock[],
  bookable: (startMin: number, endMin: number) => boolean,
): EventInput[] {
  const wk = WEEKDAYS[new Date(`${date}T00:00:00`).getDay()];
  const out: EventInput[] = [];
  for (const b of blocks) {
    if (b.weekday !== wk) continue;
    for (let s = b.start; s + b.slotMinutes <= b.end; s += b.slotMinutes) {
      if (!bookable(s, s + b.slotMinutes)) continue;
      out.push(bgEvent(date, s, s + b.slotMinutes, 'fc-slot-outline'));
    }
  }
  return out;
}
