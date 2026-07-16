import { describe, it, expect, vi } from 'vitest';
import { minutesAtClientY, clientYForMinutes, useTimegridGeometry } from '@/composables/useTimegridGeometry';

// Reference lane: 09:00 (540 min) at client-y 100px, with 2px per minute (a 30-min row = 60px).
const LANE_TOP = 100;
const LANE_MIN = 540;
const PX_PER_MIN = 2;

describe('minutesAtClientY', () => {
  it('returns the lane time at the lane top', () => {
    expect(minutesAtClientY(LANE_TOP, LANE_TOP, LANE_MIN, PX_PER_MIN)).toBe(540);
  });

  it('converts pixels below the lane into later minutes', () => {
    // 60px below 09:00 at 2px/min = +30 min → 09:30.
    expect(minutesAtClientY(160, LANE_TOP, LANE_MIN, PX_PER_MIN)).toBe(570);
  });

  it('converts pixels above the lane into earlier minutes', () => {
    expect(minutesAtClientY(40, LANE_TOP, LANE_MIN, PX_PER_MIN)).toBe(510); // 08:30
  });
});

describe('clientYForMinutes', () => {
  it('returns the lane top at the lane time', () => {
    expect(clientYForMinutes(LANE_MIN, LANE_TOP, LANE_MIN, PX_PER_MIN)).toBe(100);
  });

  it('is the inverse of minutesAtClientY', () => {
    const y = 233;
    const min = minutesAtClientY(y, LANE_TOP, LANE_MIN, PX_PER_MIN);
    expect(clientYForMinutes(min, LANE_TOP, LANE_MIN, PX_PER_MIN)).toBeCloseTo(y);
  });
});

describe('interaction geometry', () => {
  it('reuses one layout snapshot until the interaction ends', () => {
    const root = document.createElement('div');
    const lane = (time: string, top: number) => {
      const el = document.createElement('div');
      el.className = 'fc-timegrid-slot-lane';
      el.dataset.time = time;
      el.getBoundingClientRect = vi.fn(() => ({ top, left: 0, width: 0, height: 30 } as DOMRect));
      root.appendChild(el);
      return el;
    };
    const firstLane = lane('09:00:00', 100);
    const secondLane = lane('09:30:00', 160);
    const column = document.createElement('div');
    column.className = 'fc-timegrid-col';
    column.dataset.date = '2026-07-14';
    column.getBoundingClientRect = vi.fn(() => ({ top: 0, left: 50, width: 100, height: 0 } as DOMRect));
    root.appendChild(column);

    const geometry = useTimegridGeometry(() => root);
    geometry.beginInteraction?.();
    geometry.minutesAt(130);
    geometry.yForMinutes(570);
    geometry.columnAt(75);

    expect(firstLane.getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(secondLane.getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(column.getBoundingClientRect).toHaveBeenCalledTimes(1);

    geometry.endInteraction?.();
    geometry.minutesAt(130);
    expect(firstLane.getBoundingClientRect).toHaveBeenCalledTimes(2);
  });
});
