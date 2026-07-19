// Pure recurrence expansion: a series rule is stored once, occurrences are computed on demand
// from calendar-date math (no DB, no clock, no timezone — dates are plain calendar days).

import { WEEKDAYS, type Weekday } from './availability';
import type { AppointmentSeriesRow } from '../query-types';

type SeriesPattern =
  | { frequency: 'weekly'; weekday: Weekday }
  | { frequency: 'monthly_dow'; weekday: Weekday; week_of_month: number }
  | { frequency: 'monthly_dom'; day_of_month: number };

type SeriesEnd =
  | { end_kind: 'count'; end_count: number }
  | { end_kind: 'until'; end_date: string }
  | { end_kind: 'open' };

export type SeriesRule = {
  interval: number;
  start_date: string;
} & SeriesPattern & SeriesEnd;

export function seriesRuleFromRow(row: AppointmentSeriesRow): SeriesRule {
  const base = { interval: row.interval, start_date: row.start_date };
  const pattern: SeriesPattern = row.frequency === 'weekly'
    ? requireWeekdayPattern(row, 'weekly')
    : row.frequency === 'monthly_dow'
      ? requireMonthlyWeekdayPattern(row)
      : requireMonthDayPattern(row);
  const end: SeriesEnd = row.end_kind === 'count'
    ? requireCountEnd(row)
    : row.end_kind === 'until'
      ? requireUntilEnd(row)
      : { end_kind: 'open' };
  return { ...base, ...pattern, ...end };
}

function requireWeekdayPattern(row: AppointmentSeriesRow, frequency: 'weekly'): SeriesPattern {
  if (row.weekday === null) throw new Error(`${frequency} recurrence requires weekday`);
  return { frequency, weekday: row.weekday };
}

function requireMonthlyWeekdayPattern(row: AppointmentSeriesRow): SeriesPattern {
  if (row.weekday === null || row.week_of_month === null) {
    throw new Error('monthly_dow recurrence requires weekday and week_of_month');
  }
  return { frequency: 'monthly_dow', weekday: row.weekday, week_of_month: row.week_of_month };
}

function requireMonthDayPattern(row: AppointmentSeriesRow): SeriesPattern {
  if (row.day_of_month === null) throw new Error('monthly_dom recurrence requires day_of_month');
  return { frequency: 'monthly_dom', day_of_month: row.day_of_month };
}

function requireCountEnd(row: AppointmentSeriesRow): SeriesEnd {
  if (row.end_count === null) throw new Error('count recurrence requires end_count');
  return { end_kind: 'count', end_count: row.end_count };
}

function requireUntilEnd(row: AppointmentSeriesRow): SeriesEnd {
  if (row.end_date === null) throw new Error('until recurrence requires end_date');
  return { end_kind: 'until', end_date: row.end_date };
}

function parseISO(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number);
  return { y, m, d };
}

function toUTC(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d);
}

function fromUTC(t: number): string {
  const dt = new Date(t);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function weekdayIndex(w: Weekday): number {
  return WEEKDAYS.indexOf(w);
}

// Days in a given 1-based month/year, via day-0-of-next-month.
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// The 1..N-th (or last, when fromEnd) `weekday` of a given month; null if it doesn't exist.
function nthWeekdayOfMonth(y: number, m: number, weekday: number, n: number, fromEnd: boolean): string | null {
  if (!fromEnd) {
    const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    let day = 1 + ((weekday - firstDow + 7) % 7) + (n - 1) * 7;
    if (day > daysInMonth(y, m)) return null;
    return fromUTC(toUTC(y, m, day));
  }
  const last = daysInMonth(y, m);
  const lastDow = new Date(Date.UTC(y, m - 1, last)).getUTCDay();
  const day = last - ((lastDow - weekday + 7) % 7);
  return fromUTC(toUTC(y, m, day));
}

// Ordered candidate dates for one series, walked forward from start_date with no upper bound
// known to the generator itself — callers stop the iteration (window end / count reached).
function* candidateDates(rule: SeriesRule): Generator<string> {
  const start = parseISO(rule.start_date);

  if (rule.frequency === 'weekly') {
    const target = weekdayIndex(rule.weekday);
    const startUTC = toUTC(start.y, start.m, start.d);
    const startDow = new Date(startUTC).getUTCDay();
    // First candidate on/after start_date matching the weekday.
    const firstOffset = (target - startDow + 7) % 7;
    let cursor = startUTC + firstOffset * 86400000;
    const stepMs = rule.interval * 7 * 86400000;
    for (;;) {
      yield fromUTC(cursor);
      cursor += stepMs;
    }
  } else if (rule.frequency === 'monthly_dow') {
    const target = weekdayIndex(rule.weekday);
    const weekOfMonth = rule.week_of_month;
    let y = start.y;
    let m = start.m;
    const fromEnd = weekOfMonth === 5;
    for (;;) {
      const date = nthWeekdayOfMonth(y, m, target, weekOfMonth, fromEnd);
      if (date !== null && date >= rule.start_date) yield date;
      m += rule.interval;
      while (m > 12) {
        m -= 12;
        y += 1;
      }
    }
  } else {
    const dom = rule.day_of_month;
    let y = start.y;
    let m = start.m;
    for (;;) {
      if (dom <= daysInMonth(y, m)) {
        const date = fromUTC(toUTC(y, m, dom));
        if (date >= rule.start_date) yield date;
      }
      m += rule.interval;
      while (m > 12) {
        m -= 12;
        y += 1;
      }
    }
  }
}

// Occurrence dates within [windowStart, windowEnd] inclusive, ascending.
export function expandSeries(rule: SeriesRule, windowStart: string, windowEnd: string): string[] {
  const out: string[] = [];

  if (rule.end_kind === 'count') {
    // Count is global from start_date — the window only filters which of those we return, so we
    // must walk every occurrence from the beginning, not just those inside the window. Dates rise
    // monotonically, so once one lands past windowEnd no later one can still be in range.
    const limit = rule.end_count;
    let counted = 0;
    for (const date of candidateDates(rule)) {
      if (counted >= limit) break;
      counted += 1;
      if (date >= windowStart && date <= windowEnd) out.push(date);
      else if (date > windowEnd) break;
    }
    return out;
  }

  const untilBound = rule.end_kind === 'until' ? rule.end_date : null;
  for (const date of candidateDates(rule)) {
    if (date > windowEnd) break;
    if (untilBound !== null && date > untilBound) break;
    if (date >= windowStart) out.push(date);
  }
  return out;
}

export function isSeriesOccurrenceDate(rule: SeriesRule, date: string): boolean {
  return expandSeries(rule, date, date).includes(date);
}
