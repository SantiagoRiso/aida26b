import { queryOne } from '../db/core';
import type { Queryable } from '../db/core';
import { insertScheduledAppointment } from '../db/appointments';
import { DbError } from '../db/errors';
import { buildStartsAt } from '../time';
import type { AppointmentSeriesRow, AppointmentRow } from '../../../shared/src/ssot/query-types';
import { isSeriesOccurrenceDate, seriesRuleFromRow } from '../../../shared/src/ssot/domain/recurrence-expand';

export function canMaterializeOccurrence(series: AppointmentSeriesRow, occurrenceDate: string): boolean {
  return isSeriesOccurrenceDate(seriesRuleFromRow(series), occurrenceDate);
}

function selectMaterialized(db: Queryable, seriesId: string, occurrenceDate: string): Promise<AppointmentRow | null> {
  return queryOne<AppointmentRow>(
    db,
    `SELECT * FROM appointments WHERE series_id = $1 AND occurrence_date = $2`,
    [seriesId, occurrenceDate],
  );
}

// Idempotent: returns the existing (series_id, occurrence_date) appointment if present, else inserts
// one in state 'scheduled' inheriting the series identity, frozen price_ars, and snapshot
// duration_minutes (ends_at is trigger-stamped). occurrenceDate is the on-pattern anchor date. Safe
// to call repeatedly; the partial unique index (series_id, occurrence_date) is the concurrency
// backstop — on a unique violation, re-select and return the winner.
export async function ensureOccurrenceMaterialized(
  q: Queryable,
  series: AppointmentSeriesRow,
  occurrenceDate: string,
): Promise<AppointmentRow> {
  if (!canMaterializeOccurrence(series, occurrenceDate)) {
    throw new Error('ensureOccurrenceMaterialized: date is not an occurrence of the series');
  }

  const existing = await selectMaterialized(q, series.id, occurrenceDate);
  if (existing) return existing;

  // Same date+HH:MM -> business-tz timestamptz construction the schedule route uses (buildStartsAt).
  const startsAt = buildStartsAt(occurrenceDate, series.start_time.slice(0, 5));

  try {
    const inserted = await insertScheduledAppointment(q, {
      clientUserId: Number(series.client_user_id),
      professionalUserId: Number(series.professional_user_id),
      resourceId: series.resource_id == null ? null : Number(series.resource_id),
      serviceId: Number(series.service_id),
      startsAt,
      durationMinutes: series.duration_minutes,
      price: series.price_ars,
      overrideConflict: false,
      overrideActorId: null,
      name: null,
      description: null,
      seriesId: Number(series.id),
      occurrenceDate,
    });
    if (!inserted) throw new Error('ensureOccurrenceMaterialized: insert returned no row');
    return inserted;
  } catch (e) {
    const err = DbError.from(e);
    // 23505 = unique_violation: a concurrent call already materialized this occurrence.
    if (err.pgCode !== '23505') throw err;
    const winner = await selectMaterialized(q, series.id, occurrenceDate);
    if (!winner) throw new Error('ensureOccurrenceMaterialized: unique violation but no row found on re-select');
    return winner;
  }
}
