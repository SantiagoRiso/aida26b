import type { TransactionClient } from '../db/core';
import { insertScheduledAppointment } from '../db/appointments';
import { getMaterializedOccurrence } from '../db/series';
import { DbError } from '../db/errors';
import { httpError } from '../errors';
import { recheckConflictsInTx } from './scheduling';
import { buildStartsAt } from '../time';
import type { AuthUser } from '../auth';
import type { AppointmentSeriesRow, AppointmentRow } from '../../../shared/src/ssot/query-types';
import { isSeriesOccurrenceDate, seriesRuleFromRow } from '../../../shared/src/ssot/domain/recurrence-expand';

export function canMaterializeOccurrence(series: AppointmentSeriesRow, occurrenceDate: string): boolean {
  return isSeriesOccurrenceDate(seriesRuleFromRow(series), occurrenceDate);
}

// The actor materializing the occurrence — the row goes through the same conflict recheck every
// booking does, and a bypassed conflict is attributed to this actor as a sobreturno.
export type MaterializeContext = {
  businessId: number;
  actor: AuthUser;
};

// `forcedOverride` is true only when a fresh insert bypassed a real conflict, so the caller emits
// the conflict_override audit exactly once (never on an idempotent re-return or a concurrent loser).
export type MaterializeResult = { appointment: AppointmentRow; forcedOverride: boolean };

// Idempotent: returns the existing (series_id, occurrence_date) appointment if present, else inserts
// one in state 'scheduled' inheriting the series identity, frozen price_ars, and snapshot
// duration_minutes (ends_at is trigger-stamped). occurrenceDate is the on-pattern anchor date. Safe
// to call repeatedly; the partial unique index (series_id, occurrence_date) is the concurrency
// backstop — on a unique violation, re-select and return the winner. The new row is routed through
// the same per-owner advisory lock + conflict aggregator as every other booking: a one-off booked
// over this occurrence's slot is a staff-only sobreturno (flagged + audited), never a silent overlap.
export async function ensureOccurrenceMaterialized(
  tx: TransactionClient,
  series: AppointmentSeriesRow,
  occurrenceDate: string,
  ctx: MaterializeContext,
): Promise<MaterializeResult> {
  if (!canMaterializeOccurrence(series, occurrenceDate)) {
    throw new Error('ensureOccurrenceMaterialized: date is not an occurrence of the series');
  }

  const existing = await getMaterializedOccurrence(tx, series.id, occurrenceDate);
  if (existing) return { appointment: existing, forcedOverride: false };

  const start = series.start_time.slice(0, 5);
  const callerIsStaff = ctx.actor.role !== 'Client';

  const verdict = await recheckConflictsInTx(tx, {
    businessId: ctx.businessId,
    professionalUserId: Number(series.professional_user_id),
    resourceId: series.resource_id == null ? undefined : Number(series.resource_id),
    date: occurrenceDate,
    start,
    durationMinutes: series.duration_minutes,
    serviceId: Number(series.service_id),
    callerIsStaff,
  });

  // A conflict on this slot is an overridable sobreturno for staff and a hard block for a client
  // (who can never override). The materialize route already gates out clients; this is defense.
  if (verdict.requires_override && !callerIsStaff) {
    throw httpError(409, 'conflict', 'This occurrence overlaps an existing appointment');
  }
  const forced = verdict.requires_override;

  const startsAt = buildStartsAt(occurrenceDate, start);

  try {
    const inserted = await insertScheduledAppointment(tx, {
      clientUserId: Number(series.client_user_id),
      professionalUserId: Number(series.professional_user_id),
      resourceId: series.resource_id == null ? null : Number(series.resource_id),
      serviceId: Number(series.service_id),
      startsAt,
      durationMinutes: series.duration_minutes,
      price: series.price_ars,
      overrideConflict: forced,
      overrideActorId: forced ? Number(ctx.actor.id) : null,
      name: null,
      description: null,
      seriesId: Number(series.id),
      occurrenceDate,
    });
    if (!inserted) throw new Error('ensureOccurrenceMaterialized: insert returned no row');
    return { appointment: inserted, forcedOverride: forced };
  } catch (e) {
    const err = DbError.from(e);
    // 23505 = unique_violation: a concurrent call already materialized this occurrence.
    if (err.pgCode !== '23505') throw err;
    const winner = await getMaterializedOccurrence(tx, series.id, occurrenceDate);
    if (!winner) throw new Error('ensureOccurrenceMaterialized: unique violation but no row found on re-select');
    return { appointment: winner, forcedOverride: false };
  }
}
