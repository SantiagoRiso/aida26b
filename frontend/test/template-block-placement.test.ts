import { describe, it, expect } from 'vitest';
import {
  freeWindows, enclosingWindow, placeResizeTop, placeResizeBottom, placeMove,
  DAY_MIN_MINUTES, DAY_MAX_MINUTES,
} from '@/composables/templateBlockPlacement';

// Two neighbours on a day: 09:00-13:10 (540-790) and 14:00-17:20 (840-1040).
const neighbours = [{ start: 540, end: 790 }, { start: 840, end: 1040 }];

describe('templateBlockPlacement', () => {
  describe('freeWindows', () => {
    it('returns the gaps around neighbours within the visible day bounds', () => {
      expect(freeWindows(neighbours)).toEqual([
        { start: DAY_MIN_MINUTES, end: 540 },
        { start: 790, end: 840 },
        { start: 1040, end: DAY_MAX_MINUTES },
      ]);
    });

    it('returns the whole visible day when there are no neighbours', () => {
      expect(freeWindows([])).toEqual([{ start: DAY_MIN_MINUTES, end: DAY_MAX_MINUTES }]);
    });
  });

  describe('enclosingWindow', () => {
    it('finds the window a block span sits inside', () => {
      const windows = freeWindows([{ start: 840, end: 1040 }]);
      expect(enclosingWindow(windows, 540, 790)).toEqual({ start: DAY_MIN_MINUTES, end: 840 });
    });
  });

  describe('placeResizeTop', () => {
    // Editing the 14:00-17:20 block; morning neighbour 09:00-13:10 gives window 790-1380.
    const windows = freeWindows([{ start: 540, end: 790 }]);
    const block = { start: 840, end: 1040 };
    // Other blocks' edges: the morning 09:00/13:10 plus a 15:00 (900) start elsewhere.
    const edges = [540, 790, 900];

    it('snaps flush to the adjacent neighbour end', () => {
      expect(placeResizeTop(block, 795, windows, edges)).toBe(790); // 13:15 → 13:10
    });

    it('snaps onto a matching edge from another block, not just the adjacent one', () => {
      expect(placeResizeTop(block, 898, windows, edges)).toBe(900); // 14:58 → aligns to a 15:00 start
    });

    it('moves per-minute when no edge is within range', () => {
      expect(placeResizeTop(block, 953, windows, edges)).toBe(953); // 15:53, near nothing
    });

    it('cannot cross the neighbour (clamped to the window lower bound)', () => {
      expect(placeResizeTop(block, 600, windows, edges)).toBe(790);
    });

    it('respects the minimum duration', () => {
      expect(placeResizeTop(block, 1039, windows, edges)).toBe(1035); // end 1040 - 5
    });
  });

  describe('placeResizeBottom', () => {
    // Editing the 09:00-13:10 block; afternoon neighbour 14:00-17:20 gives window 360-840.
    const windows = freeWindows([{ start: 840, end: 1040 }]);
    const block = { start: 540, end: 790 };
    const edges = [720, 840, 1040]; // a 12:00 end elsewhere + the afternoon 14:00/17:20

    it('snaps flush to the adjacent neighbour start', () => {
      expect(placeResizeBottom(block, 835, windows, edges)).toBe(840); // 13:55 → 14:00
    });

    it('snaps onto a matching edge from another block', () => {
      expect(placeResizeBottom(block, 718, windows, edges)).toBe(720); // 11:58 → aligns to a 12:00 end
    });

    it('moves per-minute when no edge is within range', () => {
      expect(placeResizeBottom(block, 700, windows, edges)).toBe(700); // 11:40, near nothing
    });

    it('cannot cross the neighbour (clamped to the window upper bound)', () => {
      expect(placeResizeBottom(block, 1200, windows, edges)).toBe(840);
    });
  });

  describe('placeMove', () => {
    const windows = freeWindows(neighbours); // gap 790-840 is 50 min
    const edges = [540, 790, 840, 1040];

    it('slides into a gap and snaps the top flush when near a block edge', () => {
      expect(placeMove(40, 792, windows, edges)).toBe(790); // top 13:12 → 13:10
    });

    it('snaps the bottom flush when the block end is near a block edge', () => {
      expect(placeMove(40, 798, windows, edges)).toBe(800); // end 838 → 14:00, so start 13:20
    });

    it('moves per-minute when neither edge is within range', () => {
      expect(placeMove(30, 1151, windows, edges)).toBe(1151); // in the 1040-1380 window, near nothing
    });

    it('returns null when no window on the day can hold the duration', () => {
      expect(placeMove(400, 900, windows, edges)).toBeNull();
    });
  });
});
