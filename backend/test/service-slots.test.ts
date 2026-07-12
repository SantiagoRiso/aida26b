import { describe, it, expect } from 'vitest';
import { computeServiceSlots, computeFreeWindows } from '../../shared/src/ssot/domain/scheduling';

describe('computeServiceSlots', () => {
  it('tiles a block by the service duration, not a fixed grid', () => {
    const slots = computeServiceSlots({ blocks: [{ start: '09:00', end: '10:00', slot_minutes: 30 }] });
    expect(slots).toEqual([
      { start: '09:00', end: '09:30' },
      { start: '09:30', end: '10:00' },
    ]);
  });

  it('sizes each block by its own service duration (morning 30, afternoon 60)', () => {
    const slots = computeServiceSlots({
      blocks: [
        { start: '09:00', end: '10:00', slot_minutes: 30 },
        { start: '15:00', end: '17:00', slot_minutes: 60 },
      ],
    });
    expect(slots.map((s) => s.start)).toEqual(['09:00', '09:30', '15:00', '16:00']);
  });

  it('drops slots overlapping a booked interval', () => {
    const slots = computeServiceSlots({
      blocks: [{ start: '09:00', end: '10:00', slot_minutes: 30 }],
      booked: [{ start: '09:00', end: '09:30' }],
    });
    expect(slots).toEqual([{ start: '09:30', end: '10:00' }]);
  });

  it('drops a trailing partial slot that would exceed the block', () => {
    const slots = computeServiceSlots({ blocks: [{ start: '09:00', end: '10:00', slot_minutes: 40 }] });
    expect(slots).toEqual([{ start: '09:00', end: '09:40' }]); // 09:40–10:20 would exceed → excluded
  });

  it('subtracts a full-day unavailable exception', () => {
    const slots = computeServiceSlots({
      blocks: [{ start: '09:00', end: '10:00', slot_minutes: 30 }],
      exceptions: [{ is_unavailable: true }],
    });
    expect(slots).toEqual([]);
  });

  it('narrows the window with a partial unavailable exception', () => {
    const slots = computeServiceSlots({
      blocks: [{ start: '09:00', end: '11:00', slot_minutes: 60 }],
      exceptions: [{ is_unavailable: true, start_time: '10:00', end_time: '11:00' }],
    });
    expect(slots).toEqual([{ start: '09:00', end: '10:00' }]);
  });
});

describe('computeFreeWindows (service-agnostic)', () => {
  it('returns the raw working windows untiled, merging adjacent blocks', () => {
    const free = computeFreeWindows({
      blocks: [{ start: '09:00', end: '13:00' }, { start: '13:00', end: '17:20' }],
    });
    expect(free).toEqual([{ start: '09:00', end: '17:20' }]); // one contiguous window, no service slicing
  });

  it('removes booked spans, splitting the window into free intervals', () => {
    const free = computeFreeWindows({
      blocks: [{ start: '09:00', end: '17:00' }],
      booked: [{ start: '10:00', end: '10:30' }, { start: '13:00', end: '14:00' }],
    });
    expect(free).toEqual([
      { start: '09:00', end: '10:00' },
      { start: '10:30', end: '13:00' },
      { start: '14:00', end: '17:00' },
    ]);
  });

  it('is empty on a full-day off, and honours extra-hours / partial-block exceptions', () => {
    expect(computeFreeWindows({ blocks: [{ start: '09:00', end: '17:00' }], exceptions: [{ is_unavailable: true }] })).toEqual([]);
    const free = computeFreeWindows({
      blocks: [{ start: '09:00', end: '12:00' }],
      exceptions: [
        { is_unavailable: false, start_time: '18:00', end_time: '20:00' }, // extra hours added
        { is_unavailable: true, start_time: '10:00', end_time: '11:00' },  // partial block removed
      ],
    });
    expect(free).toEqual([
      { start: '09:00', end: '10:00' },
      { start: '11:00', end: '12:00' },
      { start: '18:00', end: '20:00' },
    ]);
  });
});
