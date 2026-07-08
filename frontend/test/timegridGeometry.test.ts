import { describe, it, expect } from 'vitest';
import { minutesAtClientY, clientYForMinutes } from '@/composables/useTimegridGeometry';

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
