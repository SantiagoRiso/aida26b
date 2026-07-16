import { describe, it, expect } from 'vitest';
import {
  bookedIntervalsByDate,
  availabilityWashEvents,
  pastWashEvent,
  slotOutlineEventsForDay,
  dayISO,
} from '@/composables/availabilityShading';
import type { EventInput } from '@fullcalendar/core';

function spans(events: EventInput[]): { start: unknown; end: unknown; cls: unknown }[] {
  return events.map((e) => ({ start: e.start, end: e.end, cls: (e.classNames as string[])[0] }));
}

const appt = (starts_at: string, ends_at: string, state = 'scheduled') => ({ starts_at, ends_at, state });

describe('bookedIntervalsByDate', () => {
  it('splits occupied vs requested and keys by local start date', () => {
    const map = bookedIntervalsByDate([
      appt('2026-07-13T09:00:00', '2026-07-13T09:30:00', 'scheduled'),
      appt('2026-07-13T10:00:00', '2026-07-13T10:45:00', 'requested'),
      appt('2026-07-14T09:00:00', '2026-07-14T10:00:00', 'completed'),
    ]);
    expect(map.get('2026-07-13')).toEqual({
      occupied: [{ start: 540, end: 570 }],
      requested: [{ start: 600, end: 645 }],
    });
    expect(map.get('2026-07-14')).toEqual({
      occupied: [{ start: 540, end: 600 }],
      requested: [],
    });
  });

  it('drops void states (canceled/rejected hold no time)', () => {
    const map = bookedIntervalsByDate([
      appt('2026-07-13T09:00:00', '2026-07-13T10:00:00', 'canceled'),
      appt('2026-07-13T11:00:00', '2026-07-13T12:00:00', 'rejected'),
    ]);
    expect(map.size).toBe(0);
  });

  it('treats an end at/after midnight as end-of-day (midnight guard)', () => {
    const map = bookedIntervalsByDate([
      // Ends exactly at next-day 00:00 → wall-clock end (0) <= start.
      appt('2026-07-13T23:00:00', '2026-07-14T00:00:00'),
      // Spills past midnight → wall-clock end (30) <= start.
      appt('2026-07-13T23:30:00', '2026-07-14T00:30:00'),
    ]);
    expect(map.get('2026-07-13')?.occupied).toEqual([
      { start: 1380, end: 1440 },
      { start: 1410, end: 1440 },
    ]);
  });
});

describe('availabilityWashEvents', () => {
  it('emits occupied/requested washes and the closed complement over the working range', () => {
    const out = availabilityWashEvents(
      '2026-07-13',
      [{ start: 540, end: 720 }], // free 09:00-12:00
      { occupied: [{ start: 720, end: 780 }], requested: [{ start: 480, end: 540 }] }, // 12:00-13:00, 08:00-09:00
      0,
    );
    expect(spans(out)).toEqual([
      { start: '2026-07-13T12:00:00', end: '2026-07-13T13:00:00', cls: 'fc-slot-occupied' },
      { start: '2026-07-13T08:00:00', end: '2026-07-13T09:00:00', cls: 'fc-slot-requested-bg' },
      // Working = free ∪ booked = 08:00-13:00; the rest of the day is the closed hatch.
      { start: '2026-07-13T00:00:00', end: '2026-07-13T08:00:00', cls: 'fc-res-closed' },
      { start: '2026-07-13T13:00:00', end: '2026-07-13T24:00:00', cls: 'fc-res-closed' },
    ]);
  });

  it('clips washes to the floor and starts the closed hatch there', () => {
    const out = availabilityWashEvents(
      '2026-07-13',
      [{ start: 540, end: 660 }], // free 09:00-11:00
      { occupied: [{ start: 540, end: 600 }], requested: [] }, // 09:00-10:00
      570, // now = 09:30
    );
    expect(spans(out)).toEqual([
      // Occupied wash clipped to 09:30; free time keeps the closed complement out until 11:00.
      { start: '2026-07-13T09:30:00', end: '2026-07-13T10:00:00', cls: 'fc-slot-occupied' },
      { start: '2026-07-13T11:00:00', end: '2026-07-13T24:00:00', cls: 'fc-res-closed' },
    ]);
  });

  it('drops a wash fully below the floor instead of emitting an inverted span', () => {
    const out = availabilityWashEvents(
      '2026-07-13',
      [],
      { occupied: [{ start: 480, end: 540 }], requested: [] }, // ended 09:00
      600, // now = 10:00
    );
    expect(spans(out)).toEqual([
      { start: '2026-07-13T10:00:00', end: '2026-07-13T24:00:00', cls: 'fc-res-closed' },
    ]);
  });

  it('merges adjacent booked intervals into one wash', () => {
    const out = availabilityWashEvents(
      '2026-07-13',
      [{ start: 540, end: 720 }],
      { occupied: [{ start: 540, end: 570 }, { start: 570, end: 600 }], requested: [] },
      0,
    );
    const occupied = out.filter((e) => (e.classNames as string[])[0] === 'fc-slot-occupied');
    expect(spans(occupied)).toEqual([
      { start: '2026-07-13T09:00:00', end: '2026-07-13T10:00:00', cls: 'fc-slot-occupied' },
    ]);
  });
});

describe('pastWashEvent', () => {
  it('covers the whole column for a past day', () => {
    const ev = pastWashEvent('2026-07-10', '2026-07-13', 615);
    expect(ev).toMatchObject({
      start: '2026-07-10T00:00:00',
      end: '2026-07-11T00:00:00',
      display: 'background',
      classNames: ['fc-slot-past'],
    });
  });

  it('rolls a past day over a month boundary', () => {
    const ev = pastWashEvent('2026-06-30', '2026-07-13', 0);
    expect(ev?.end).toBe('2026-07-01T00:00:00');
  });

  it('covers today only up to the floor', () => {
    const ev = pastWashEvent('2026-07-13', '2026-07-13', 615);
    expect(ev).toMatchObject({ start: '2026-07-13T00:00:00', end: '2026-07-13T10:15:00' });
  });

  it('emits nothing for today at midnight or for a future day', () => {
    expect(pastWashEvent('2026-07-13', '2026-07-13', 0)).toBeNull();
    expect(pastWashEvent('2026-07-14', '2026-07-13', 615)).toBeNull();
  });
});

describe('slotOutlineEventsForDay', () => {
  // 2026-07-13 is a Monday.
  const monday = '2026-07-13';

  it('tiles a block by its own slot size and drops the trailing partial', () => {
    const out = slotOutlineEventsForDay(
      monday,
      [{ weekday: 'mon', start: 540, end: 615, slotMinutes: 30 }], // 09:00-10:15
      () => true,
    );
    expect(spans(out)).toEqual([
      { start: '2026-07-13T09:00:00', end: '2026-07-13T09:30:00', cls: 'fc-slot-outline' },
      { start: '2026-07-13T09:30:00', end: '2026-07-13T10:00:00', cls: 'fc-slot-outline' },
      // 10:00-10:30 would overrun the block end (10:15) — dropped, not clipped.
    ]);
  });

  it('skips blocks on other weekdays', () => {
    const out = slotOutlineEventsForDay(
      monday,
      [{ weekday: 'tue', start: 540, end: 600, slotMinutes: 30 }],
      () => true,
    );
    expect(out).toEqual([]);
  });

  it('tiles each block by its own step when sizes differ', () => {
    const out = slotOutlineEventsForDay(
      monday,
      [
        { weekday: 'mon', start: 540, end: 600, slotMinutes: 30 },
        { weekday: 'mon', start: 840, end: 930, slotMinutes: 45 },
      ],
      () => true,
    );
    expect(out.map((e) => e.start)).toEqual([
      '2026-07-13T09:00:00',
      '2026-07-13T09:30:00',
      '2026-07-13T14:00:00',
      '2026-07-13T14:45:00',
    ]);
  });

  it('only outlines slots the bookable predicate accepts', () => {
    const taken = [{ start: 570, end: 600 }]; // 09:30-10:00 booked
    const out = slotOutlineEventsForDay(
      monday,
      [{ weekday: 'mon', start: 540, end: 660, slotMinutes: 30 }], // 09:00-11:00
      (s, e) => !taken.some((k) => s < k.end && k.start < e),
    );
    expect(out.map((e) => e.start)).toEqual([
      '2026-07-13T09:00:00',
      '2026-07-13T10:00:00',
      '2026-07-13T10:30:00',
    ]);
  });
});

describe('dayISO', () => {
  it('formats the local date with an offset in days', () => {
    expect(dayISO(new Date(2026, 6, 13, 23, 59), 0)).toBe('2026-07-13');
    expect(dayISO(new Date(2026, 6, 31), 1)).toBe('2026-08-01');
  });
});
