import { describe, it, expect } from 'vitest';
import { seriesOccupancyForDate } from '../../shared/src/ssot/domain/recurrence-occupancy';
import type { AppointmentSeriesRow } from '../../shared/src/ssot/query-types';

function makeSeries(overrides: Partial<AppointmentSeriesRow> = {}): AppointmentSeriesRow {
  return {
    id: '7',
    client_user_id: '1',
    professional_user_id: '2',
    service_id: '3',
    resource_id: null,
    frequency: 'weekly',
    interval: 1,
    weekday: 'mon',
    week_of_month: null,
    day_of_month: null,
    start_time: '09:00:00',
    duration_minutes: 30,
    price_ars: '1500.00',
    start_date: '2026-07-06',
    end_kind: 'open',
    end_count: null,
    end_date: null,
    created_by_user_id: '2',
    status: 'active',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('seriesOccupancyForDate', () => {
  it('emits one occupied interval for a series whose pattern hits the date, with no override', () => {
    const out = seriesOccupancyForDate([makeSeries()], '2026-07-13', new Set());
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ id: -7, start: '09:00', end: '09:30', state: 'scheduled' });
  });

  it('dedupes when the (series_id, date) key is materialized', () => {
    const out = seriesOccupancyForDate([makeSeries()], '2026-07-13', new Set(['7|2026-07-13']));
    expect(out).toHaveLength(0);
  });

  it('emits nothing when the pattern does not hit the date', () => {
    // 2026-07-14 is a Tuesday; the series fires Mondays.
    const out = seriesOccupancyForDate([makeSeries()], '2026-07-14', new Set());
    expect(out).toHaveLength(0);
  });

  it('normalizes a SQL TIME start_time and computes end from duration_minutes', () => {
    const out = seriesOccupancyForDate(
      [makeSeries({ start_time: '09:00:00', duration_minutes: 50 })],
      '2026-07-13',
      new Set(),
    );
    expect(out[0].start).toBe('09:00');
    expect(out[0].end).toBe('09:50');
  });
});
