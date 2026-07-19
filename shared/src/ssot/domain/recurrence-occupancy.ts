// Virtual occupancy for un-materialized recurring occurrences: a series is never stored per-date,
// so the conflict aggregator and availability calculator need this to "see" its pattern as booked
// time. Pure — no DB, no clock, no backend time helpers.

import type { AppointmentSeriesRow } from '../query-types';
import type { BookedAppointment } from './conflict';
import { expandSeries, seriesRuleFromRow } from './recurrence-expand';
import { toMinutes, toHHMM } from './availability';

// One occupied interval per active series whose pattern hits `date`, skipping series that already
// have a materialized override for (series_id, date) — that occurrence's real appointments row
// carries it through the normal booked path instead (canceled ⇒ free, moved ⇒ occupies its new
// time). id is a negative sentinel so it can never collide with a real (positive) appointment id.
export function seriesOccupancyForDate(
  series: AppointmentSeriesRow[],
  date: string,
  materializedKeys: Set<string>,
): BookedAppointment[] {
  const out: BookedAppointment[] = [];
  for (const s of series) {
    if (materializedKeys.has(`${s.id}|${date}`)) continue;
    const hits = expandSeries(seriesRuleFromRow(s), date, date);
    if (hits.length === 0) continue;
    const start = s.start_time.slice(0, 5);
    const end = toHHMM(toMinutes(start) + s.duration_minutes);
    out.push({ id: -Number(s.id), start, end, state: 'scheduled' });
  }
  return out;
}
