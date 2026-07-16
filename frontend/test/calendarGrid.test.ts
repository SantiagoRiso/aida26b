import { describe, it, expect } from 'vitest';
import {
  gcd, gcdAll, computeSnapMinutes, tileFreeWindows, resolveDrop, snapDragMinutes,
  exceedsEndOfDay, complementIntervals,
} from '@/composables/calendarGrid';
import { mergeIntervals } from '@shared/ssot/domain/availability';

describe('complementIntervals', () => {
  it('returns the gaps around a single free window within [min,max]', () => {
    // Free 09:00-12:00 within a 08:00-18:00 range → blocked 08:00-09:00 and 12:00-18:00.
    expect(complementIntervals([{ start: 540, end: 720 }], 480, 1080)).toEqual([
      { start: 480, end: 540 },
      { start: 720, end: 1080 },
    ]);
  });

  it('returns the whole range when there are no free windows (no availability)', () => {
    expect(complementIntervals([], 420, 1260)).toEqual([{ start: 420, end: 1260 }]);
  });

  it('returns nothing when free covers the entire range', () => {
    expect(complementIntervals([{ start: 420, end: 1260 }], 420, 1260)).toEqual([]);
  });

  it('merges adjacent free windows and yields only the true gaps', () => {
    // 09:00-10:00 and 10:00-11:00 are contiguous → one gap after 11:00.
    expect(complementIntervals([{ start: 540, end: 600 }, { start: 600, end: 660 }], 540, 720)).toEqual([
      { start: 660, end: 720 },
    ]);
  });

  it('clips free windows that extend beyond the visible range', () => {
    // Free 06:00-20:00 but range only 07:00-19:00 → no blocked time in view.
    expect(complementIntervals([{ start: 360, end: 1200 }], 420, 1140)).toEqual([]);
  });
});

describe('exceedsEndOfDay', () => {
  it('allows a duration that ends before midnight', () => {
    expect(exceedsEndOfDay(22 * 60, 60)).toBe(false); // 22:00 + 60 = 23:00
  });
  it('allows a duration that ends exactly at midnight', () => {
    expect(exceedsEndOfDay(23 * 60, 60)).toBe(false); // 23:00 + 60 = 24:00 (inclusive edge)
  });
  it('rejects a duration that runs past midnight', () => {
    expect(exceedsEndOfDay(23 * 60 + 30, 60)).toBe(true); // 23:30 + 60 = 00:30 next day
  });
  it('rejects a non-positive duration (end wrapped to the next day)', () => {
    expect(exceedsEndOfDay(23 * 60, -1380)).toBe(true);
    expect(exceedsEndOfDay(9 * 60, 0)).toBe(true);
  });
});

describe('gcd / gcdAll', () => {
  it('gcd of 30 and 20 is 10', () => expect(gcd(30, 20)).toBe(10));
  it('gcd handles a zero operand', () => expect(gcd(0, 15)).toBe(15));
  it('gcdAll of an empty list is 0', () => expect(gcdAll([])).toBe(0));
  it('gcdAll of [30,60,90] is 30', () => expect(gcdAll([30, 60, 90])).toBe(30));
});

describe('computeSnapMinutes', () => {
  it('uniform 30-min grid from origin yields the granularity', () => {
    // starts 09:00,09:30,10:00 from a 07:00 origin, 30-min rows.
    const starts = [540, 570, 600];
    expect(computeSnapMinutes(starts, 420, 30)).toBe(30);
  });

  it('mixed granularity/phase yields a finer step that still divides the row', () => {
    // 09:00 (30-min block) and 14:15 (off-phase) → offsets 120 and 435 from a 07:00 origin.
    // gcd(120, 435, 30) = 15.
    const starts = [540, 855];
    expect(computeSnapMinutes(starts, 420, 30)).toBe(15);
  });

  it('falls back to slotMinutes when there are no slots', () => {
    expect(computeSnapMinutes([], 420, 30)).toBe(30);
  });
});

describe('mergeIntervals', () => {
  it('merges touching intervals (end === next.start)', () => {
    expect(mergeIntervals([{ start: 540, end: 570 }, { start: 570, end: 600 }]))
      .toEqual([{ start: 540, end: 600 }]);
  });
  it('keeps a gap separate', () => {
    expect(mergeIntervals([{ start: 540, end: 570 }, { start: 660, end: 690 }]))
      .toEqual([{ start: 540, end: 570 }, { start: 660, end: 690 }]);
  });
});

describe('tileFreeWindows', () => {
  const slots = [
    { start: '09:00', end: '09:30' },
    { start: '09:30', end: '10:00' },
    { start: '10:30', end: '11:00' }, // isolated (gap at 10:00-10:30)
  ];

  it('30-min appointment fits at every free slot start', () => {
    expect(tileFreeWindows(slots, 30)).toEqual(['09:00', '09:30', '10:30']);
  });

  it('60-min appointment fits only where two slots are contiguous', () => {
    // 09:00 → 10:00 fits (09:00-10:00 merged). 09:30 → 10:30 does NOT (gap). 10:30 → 11:30 does NOT.
    expect(tileFreeWindows(slots, 60)).toEqual(['09:00']);
  });

  it('tiles an open free window into back-to-back slots, not just its start', () => {
    // A single wide window must offer every fitting position, not only 09:20 (the "only first slot" bug).
    expect(tileFreeWindows([{ start: '09:20', end: '11:50' }], 50)).toEqual(['09:20', '10:10', '11:00']);
  });
});

describe('resolveDrop', () => {
  const valid = [540, 570, 630]; // 09:00, 09:30, 10:30

  it('returns the exact valid start when dropped on it', () => {
    expect(resolveDrop(valid, 570, 15)).toBe(570);
  });
  it('snaps to the nearest valid start within threshold', () => {
    expect(resolveDrop(valid, 575, 15)).toBe(570);
  });
  it('refuses (null) when no valid start is within threshold', () => {
    expect(resolveDrop(valid, 600, 15)).toBeNull(); // 10:00, 30 min from either neighbor
  });
  it('refuses on an empty valid set', () => {
    expect(resolveDrop([], 540, 15)).toBeNull();
  });
});

describe('snapDragMinutes', () => {
  const valid = [540, 590, 640]; // 09:00, 09:50, 10:40 (50-min lattice)

  it('coarse magnetizes to a nearby valid slot', () => {
    expect(snapDragMinutes(552, valid, false)).toBe(540);
    expect(snapDragMinutes(628, valid, false)).toBe(640);
  });

  it('coarse remains free when no valid slot is nearby', () => {
    expect(snapDragMinutes(675, valid, false)).toBe(675);
  });

  it('fine rounds to the nearest 5 min, off the lattice', () => {
    expect(snapDragMinutes(557, valid, true)).toBe(555);
    expect(snapDragMinutes(543, valid, true)).toBe(545);
  });

  it('falls back to 5-min rounding when there are no slots to snap to', () => {
    expect(snapDragMinutes(557, [], false)).toBe(555);
  });
});
