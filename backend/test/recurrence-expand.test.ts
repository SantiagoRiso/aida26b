import { describe, it, expect } from 'vitest';
import { expandSeries, isSeriesOccurrenceDate } from '../../shared/src/ssot/domain/recurrence-expand';

describe('expandSeries', () => {
  it('weekly interval 2, Mondays', () => {
    expect(
      expandSeries(
        { frequency: 'weekly', interval: 2, weekday: 'mon', start_date: '2026-07-06', end_kind: 'open' },
        '2026-07-01',
        '2026-08-01',
      ),
    ).toEqual(['2026-07-06', '2026-07-20']);
  });

  it('weekly interval 1', () => {
    expect(
      expandSeries(
        { frequency: 'weekly', interval: 1, weekday: 'mon', start_date: '2026-07-06', end_kind: 'open' },
        '2026-07-01',
        '2026-08-01',
      ),
    ).toEqual(['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27']);
  });

  it('monthly_dow 3rd Tuesday', () => {
    expect(
      expandSeries(
        {
          frequency: 'monthly_dow',
          interval: 1,
          weekday: 'tue',
          week_of_month: 3,
          start_date: '2026-07-01',
          end_kind: 'open',
        },
        '2026-07-01',
        '2026-09-30',
      ),
    ).toEqual(['2026-07-21', '2026-08-18', '2026-09-15']);
  });

  it('monthly_dow LAST Friday (week_of_month:5)', () => {
    expect(
      expandSeries(
        {
          frequency: 'monthly_dow',
          interval: 1,
          weekday: 'fri',
          week_of_month: 5,
          start_date: '2026-02-01',
          end_kind: 'open',
        },
        '2026-02-01',
        '2026-03-31',
      ),
    ).toEqual(['2026-02-27', '2026-03-27']);
  });

  it('monthly_dom day 31 — Feb & Apr skipped', () => {
    expect(
      expandSeries(
        { frequency: 'monthly_dom', interval: 1, day_of_month: 31, start_date: '2026-01-31', end_kind: 'open' },
        '2026-02-01',
        '2026-05-01',
      ),
    ).toEqual(['2026-03-31']);
  });

  it('end_kind count — global count, windowed slice (from window start)', () => {
    expect(
      expandSeries(
        { frequency: 'weekly', interval: 1, weekday: 'mon', start_date: '2026-07-06', end_kind: 'count', end_count: 3 },
        '2026-07-01',
        '2026-12-31',
      ),
    ).toEqual(['2026-07-06', '2026-07-13', '2026-07-20']);
  });

  it('end_kind count — count not restarted at window', () => {
    expect(
      expandSeries(
        { frequency: 'weekly', interval: 1, weekday: 'mon', start_date: '2026-07-06', end_kind: 'count', end_count: 3 },
        '2026-07-20',
        '2026-12-31',
      ),
    ).toEqual(['2026-07-20']);
  });

  it('end_kind until', () => {
    expect(
      expandSeries(
        { frequency: 'weekly', interval: 1, weekday: 'mon', start_date: '2026-07-06', end_kind: 'until', end_date: '2026-07-20' },
        '2026-07-01',
        '2026-08-31',
      ),
    ).toEqual(['2026-07-06', '2026-07-13', '2026-07-20']);
  });

  it('start_date respected — nothing emitted before it', () => {
    expect(
      expandSeries(
        { frequency: 'weekly', interval: 1, weekday: 'mon', start_date: '2026-07-13', end_kind: 'open' },
        '2026-07-01',
        '2026-07-31',
      ),
    ).toEqual(['2026-07-13', '2026-07-20', '2026-07-27']);
  });

  // Additional edge cases.

  it('monthly_dom interval 2 — every other month from start', () => {
    expect(
      expandSeries(
        { frequency: 'monthly_dom', interval: 2, day_of_month: 15, start_date: '2026-01-15', end_kind: 'open' },
        '2026-01-01',
        '2026-06-30',
      ),
    ).toEqual(['2026-01-15', '2026-03-15', '2026-05-15']);
  });

  it('monthly_dow crosses a year boundary (Dec → Jan)', () => {
    expect(
      expandSeries(
        {
          frequency: 'monthly_dow',
          interval: 1,
          weekday: 'mon',
          week_of_month: 1,
          start_date: '2026-11-01',
          end_kind: 'open',
        },
        '2026-12-01',
        '2027-01-31',
      ),
    ).toEqual(['2026-12-07', '2027-01-04']);
  });

  it('weekly window with no overlapping occurrences returns empty', () => {
    expect(
      expandSeries(
        { frequency: 'weekly', interval: 1, weekday: 'mon', start_date: '2026-07-06', end_kind: 'open' },
        '2026-06-01',
        '2026-06-30',
      ),
    ).toEqual([]);
  });
});

describe('isSeriesOccurrenceDate', () => {
  const rule = {
    frequency: 'weekly' as const,
    interval: 1,
    weekday: 'mon',
    start_date: '2026-07-13',
    end_kind: 'until' as const,
    end_date: '2026-07-27',
  };

  it('accepts a generated occurrence', () => {
    expect(isSeriesOccurrenceDate(rule, '2026-07-20')).toBe(true);
  });

  it.each(['2026-07-06', '2026-07-21', '2026-08-03'])('rejects %s outside the rule', (date) => {
    expect(isSeriesOccurrenceDate(rule, date)).toBe(false);
  });
});
