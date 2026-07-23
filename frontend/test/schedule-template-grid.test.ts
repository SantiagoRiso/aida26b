import { describe, it, expect } from 'vitest';
import {
  weekdayToDate, dateToWeekday, overlaps, eventToWeekdayTimes, blockToEvent, decideCreate, decideUpdate,
  snapToNeighbors, type TemplateBlock,
} from '@/composables/scheduleTemplateGrid';

describe('scheduleTemplateGrid', () => {
  it('maps weekday to the fixed reference week (Mon 2024-01-01 .. Sun 2024-01-07)', () => {
    expect(weekdayToDate('mon')).toBe('2024-01-01');
    expect(weekdayToDate('wed')).toBe('2024-01-03');
    expect(weekdayToDate('sun')).toBe('2024-01-07');
  });

  it('maps a fixed-week date back to its weekday', () => {
    expect(dateToWeekday('2024-01-01')).toBe('mon');
    expect(dateToWeekday('2024-01-07')).toBe('sun');
  });

  it('round-trips a block to an event and back to weekday+times', () => {
    const ev = blockToEvent({ id: '1', professional_user_id: '9', weekday: 'tue', start_time: '09:00', end_time: '12:00' });
    expect(ev.start).toBe('2024-01-02T09:00:00');
    expect(ev.end).toBe('2024-01-02T12:00:00');
    const back = eventToWeekdayTimes('2024-01-02T09:00:00', '2024-01-02T12:00:00');
    expect(back).toEqual({ weekday: 'tue', start_time: '09:00', end_time: '12:00' });
  });

  it('builds a valid event datetime from an API time serialised as HH:MM:SS', () => {
    const ev = blockToEvent({ id: '1', professional_user_id: '9', weekday: 'mon', start_time: '09:00:00', end_time: '17:20:00' });
    expect(ev.start).toBe('2024-01-01T09:00:00');
    expect(ev.end).toBe('2024-01-01T17:20:00');
  });

  it('detects an overlap only within the same weekday, ignoring the edited block', () => {
    const others: TemplateBlock[] = [
      { id: '1', professional_user_id: '9', weekday: 'mon', start_time: '09:00', end_time: '12:00' },
      { id: '2', professional_user_id: '9', weekday: 'tue', start_time: '09:00', end_time: '12:00' },
    ];
    expect(overlaps({ weekday: 'mon', start_time: '11:00', end_time: '13:00' }, others)).toBe(true);
    expect(overlaps({ weekday: 'mon', start_time: '12:00', end_time: '13:00' }, others)).toBe(false); // end-exclusive
    expect(overlaps({ weekday: 'wed', start_time: '09:00', end_time: '12:00' }, others)).toBe(false);
    expect(overlaps({ weekday: 'mon', start_time: '09:30', end_time: '10:00' }, others, '1')).toBe(false); // ignore self
  });

  describe('snapToNeighbors', () => {
    // Edges available to snap onto: 09:00, 12:00, 15:00, 18:00.
    const neighbours: TemplateBlock[] = [
      { id: '1', professional_user_id: '9', weekday: 'mon', start_time: '09:00', end_time: '12:00' },
      { id: '2', professional_user_id: '9', weekday: 'mon', start_time: '15:00', end_time: '18:00' },
    ];

    it('snaps a start onto a nearby block edge within threshold', () => {
      // 12:07 is 7 min past the 12:00 end of block 1 (≤ 10) → snap onto it.
      const snapped = snapToNeighbors({ weekday: 'mon', start_time: '12:07', end_time: '14:00' }, neighbours);
      expect(snapped).toEqual({ weekday: 'mon', start_time: '12:00', end_time: '14:00' });
    });

    it('snaps an end onto a nearby block edge within threshold', () => {
      const snapped = snapToNeighbors({ weekday: 'mon', start_time: '13:00', end_time: '14:55' }, neighbours);
      expect(snapped).toEqual({ weekday: 'mon', start_time: '13:00', end_time: '15:00' });
    });

    it('aligns a start to another block\'s START edge, not just an adjacent end', () => {
      // 09:07 is 7 min after the 09:00 start of block 1 → snaps to align starts.
      const snapped = snapToNeighbors({ weekday: 'mon', start_time: '09:07', end_time: '10:30' }, neighbours);
      expect(snapped).toEqual({ weekday: 'mon', start_time: '09:00', end_time: '10:30' });
    });

    it('leaves an edge untouched when the nearest edge is beyond threshold', () => {
      const snapped = snapToNeighbors({ weekday: 'mon', start_time: '12:20', end_time: '14:00' }, neighbours);
      expect(snapped).toEqual({ weekday: 'mon', start_time: '12:20', end_time: '14:00' });
    });

    it('snaps to edges regardless of weekday, so blocks align across days', () => {
      const snapped = snapToNeighbors({ weekday: 'tue', start_time: '12:07', end_time: '14:00' }, neighbours);
      expect(snapped).toEqual({ weekday: 'tue', start_time: '12:00', end_time: '14:00' });
    });

    it('ignores the block being edited so it never snaps to its own edges', () => {
      const snapped = snapToNeighbors({ weekday: 'mon', start_time: '12:04', end_time: '14:00' }, neighbours, '1');
      expect(snapped).toEqual({ weekday: 'mon', start_time: '12:04', end_time: '14:00' });
    });
  });

  describe('decideCreate', () => {
    const existing: TemplateBlock[] = [
      { id: '1', professional_user_id: '9', weekday: 'mon', start_time: '09:00', end_time: '12:00' },
    ];

    it('accepts a non-overlapping candidate and returns its weekday+times body', () => {
      const result = decideCreate({ startStr: '2024-01-01T13:00:00', endStr: '2024-01-01T14:00:00' }, existing);
      expect(result).toEqual({ ok: true, body: { weekday: 'mon', start_time: '13:00', end_time: '14:00' } });
    });

    it('rejects an overlapping candidate', () => {
      const result = decideCreate({ startStr: '2024-01-01T10:00:00', endStr: '2024-01-01T11:00:00' }, existing);
      expect(result).toEqual({ ok: false, reason: 'overlap' });
    });

    it('rejects a start >= end candidate', () => {
      const result = decideCreate({ startStr: '2024-01-03T10:00:00', endStr: '2024-01-03T10:00:00' }, existing);
      expect(result).toEqual({ ok: false, reason: 'invalid' });
    });

    it('rejects a candidate that crosses midnight into the next date', () => {
      const result = decideCreate({ startStr: '2024-01-03T23:30:00', endStr: '2024-01-04T00:15:00' }, existing);
      expect(result).toEqual({ ok: false, reason: 'invalid' });
    });
  });

  describe('decideUpdate', () => {
    const existing: TemplateBlock[] = [
      { id: '1', professional_user_id: '9', weekday: 'mon', start_time: '09:00', end_time: '12:00' },
      { id: '2', professional_user_id: '9', weekday: 'tue', start_time: '09:00', end_time: '12:00' },
    ];

    it('ignores the moved block itself when checking overlap', () => {
      const result = decideUpdate({ startStr: '2024-01-01T10:00:00', endStr: '2024-01-01T13:00:00' }, existing, '1');
      expect(result).toEqual({ ok: true, body: { weekday: 'mon', start_time: '10:00', end_time: '13:00' } });
    });

    it('still rejects overlap with a different block on the same weekday', () => {
      const result = decideUpdate({ startStr: '2024-01-02T10:00:00', endStr: '2024-01-02T11:00:00' }, existing, '1');
      expect(result).toEqual({ ok: false, reason: 'overlap' });
    });

    it('allows moving to a different weekday when it does not overlap there', () => {
      const result = decideUpdate({ startStr: '2024-01-03T09:00:00', endStr: '2024-01-03T10:00:00' }, existing, '1');
      expect(result).toEqual({ ok: true, body: { weekday: 'wed', start_time: '09:00', end_time: '10:00' } });
    });
  });
});
