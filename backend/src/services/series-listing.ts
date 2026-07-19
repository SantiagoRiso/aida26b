import type { Queryable } from '../db/core';
import {
  expandSeries,
  seriesRuleFromRow,
  evaluateConflicts,
  OPEN_APPOINTMENT_STATES,
} from '../../../shared/src/ssot/domain';
import type { AppointmentRow, AppointmentSeriesRow, VirtualOccurrence } from '../../../shared/src/ssot/query-types';
import {
  getActiveSeriesForOwner,
  getActiveSeriesForClient,
  getActiveSeriesForBusiness,
  getActiveSeriesForGrantee,
  getMaterializedOverrides,
} from '../db/series';
import { loadOwnerState, toAggregatorOwner, type OwnerState } from './scheduling';
import { addMinutes, businessDateTimeToISO } from '../time';
import type { AppointmentRoleScope } from '../db/appointments';

export type VirtualOccurrenceFilter = {
  businessId: number;
  roleScope: AppointmentRoleScope;
  windowStart: string;
  windowEnd: string;
  professionalUserId?: number;
  resourceId?: number;
  clientUserId?: number;
  state?: string;
  conflicting?: boolean;
};

// Role-scoped series fetch, mirroring listAppointments' scoping exactly (same predicate per role),
// then narrowed further by any explicit filter query params — narrowing only, never widening past
// the role scope above.
async function loadInScopeSeries(q: Queryable, f: VirtualOccurrenceFilter): Promise<AppointmentSeriesRow[]> {
  const businessId = String(f.businessId);
  let series: AppointmentSeriesRow[];
  if (f.roleScope.kind === 'client') {
    series = await getActiveSeriesForClient(q, businessId, String(f.roleScope.userId), f.windowStart, f.windowEnd);
  } else if (f.roleScope.kind === 'professional') {
    series = await getActiveSeriesForOwner(q, businessId, String(f.roleScope.userId), f.windowStart, f.windowEnd);
  } else if (f.roleScope.kind === 'receptionist') {
    series = await getActiveSeriesForGrantee(q, businessId, String(f.roleScope.granteeUserId), f.windowStart, f.windowEnd);
  } else {
    series = await getActiveSeriesForBusiness(q, businessId, f.windowStart, f.windowEnd);
  }

  if (f.professionalUserId != null) series = series.filter((s) => s.professional_user_id === String(f.professionalUserId));
  if (f.resourceId != null) series = series.filter((s) => s.resource_id === String(f.resourceId));
  if (f.clientUserId != null) series = series.filter((s) => s.client_user_id === String(f.clientUserId));

  return series;
}

// Expands every in-scope active series over [windowStart, windowEnd] into virtual occurrences,
// skipping any date already materialized (real row — canceled included, so a canceled occurrence
// is never re-added as virtual). loadOwnerState is memoized per (professional, service, date) since
// many occurrences on the same day/series share one owner-state load.
export async function listVirtualOccurrences(q: Queryable, f: VirtualOccurrenceFilter): Promise<VirtualOccurrence[]> {
  // Virtuals are always state='scheduled' — an incompatible state filter can never match one.
  if (f.state != null && f.state !== 'scheduled') return [];

  const series = await loadInScopeSeries(q, f);
  if (series.length === 0) return [];

  const overrides = await getMaterializedOverrides(q, series.map((s) => s.id), f.windowStart, f.windowEnd);
  const materializedKeys = new Set(overrides.map((o) => `${o.series_id}|${o.occurrence_date}`));

  const ownerStateCache = new Map<string, OwnerState | null>();
  const cachedOwnerState = async (professionalUserId: string, serviceId: string, date: string): Promise<OwnerState | null> => {
    const key = `${professionalUserId}|${serviceId}|${date}`;
    if (!ownerStateCache.has(key)) {
      const state = await loadOwnerState(
        q,
        f.businessId,
        { kind: 'professional', id: Number(professionalUserId) },
        date,
        { serviceId: Number(serviceId) },
      );
      ownerStateCache.set(key, state);
    }
    return ownerStateCache.get(key) ?? null;
  };

  // Mirrors loadConflictInputs/recheckConflictsInTx: a resource-carrying occurrence must also
  // clash-check the resource owner, not just the professional — a resource double-booking with a
  // free professional would otherwise never surface as in_conflict. Memoized by (resourceId, date)
  // alongside the professional cache, since many occurrences share one resource/day.
  const resourceStateCache = new Map<string, OwnerState | null>();
  const cachedResourceState = async (resourceId: string, date: string): Promise<OwnerState | null> => {
    const key = `${resourceId}|${date}`;
    if (!resourceStateCache.has(key)) {
      const state = await loadOwnerState(q, f.businessId, { kind: 'resource', id: Number(resourceId) }, date);
      resourceStateCache.set(key, state);
    }
    return resourceStateCache.get(key) ?? null;
  };

  const out: VirtualOccurrence[] = [];
  for (const s of series) {
    const dates = expandSeries(seriesRuleFromRow(s), f.windowStart, f.windowEnd);
    const startTime = s.start_time.slice(0, 5);

    for (const date of dates) {
      if (materializedKeys.has(`${s.id}|${date}`)) continue;

      const ownerState = await cachedOwnerState(s.professional_user_id, s.service_id, date);
      const resourceState = s.resource_id != null ? await cachedResourceState(s.resource_id, date) : null;
      let inConflict = false;
      if (ownerState) {
        // Same predicate the write-path conflict aggregator uses: not contained in the grid
        // (day-off/out-of-hours) or overlapping another booked interval. Excludes this occurrence's
        // own virtual occupancy (seriesOccupancyForDate stamps it with id = -series.id) so a series
        // never conflicts with itself. Resource passed alongside the professional (when the series
        // carries one) so a resource-only clash — professional free, resource double-booked — is
        // caught too.
        const verdict = evaluateConflicts({
          proposed: { start: startTime, end: addMinutes(startTime, s.duration_minutes), date },
          callerIsStaff: true,
          excludeAppointmentId: -Number(s.id),
          professional: toAggregatorOwner(ownerState),
          resource: resourceState ? toAggregatorOwner(resourceState) : undefined,
        });
        inConflict = !verdict.can_save;
      }

      if (f.conflicting && !inConflict) continue;

      out.push({
        id: null,
        series_id: s.id,
        occurrence_date: date,
        client_user_id: s.client_user_id,
        professional_user_id: s.professional_user_id,
        service_id: s.service_id,
        resource_id: s.resource_id,
        starts_at: businessDateTimeToISO(date, startTime),
        duration_minutes: s.duration_minutes,
        price: s.price_ars,
        state: 'scheduled',
        name: null,
        description: null,
        is_virtual: true,
        in_conflict: inConflict,
      });
    }
  }

  return out;
}

const OPEN_STATES = new Set<string>(OPEN_APPOINTMENT_STATES);

// The reverse of listVirtualOccurrences' flagging: a real turno gains in_conflict when a conflicting
// virtual occurrence of an active series lands on top of it, so a recurring rule booked over an
// existing turno rings both sides on the calendar, not just the occurrence. Eligibility mirrors the
// stored-flag predicate (open, future, not staff-ignored — the same OPEN_APPOINTMENT_STATES source
// as appointmentInConflictSql). Owner match counts a resource clash alongside a professional clash,
// as the aggregator does. Mutates in place; already-flagged rows (time-off) are left untouched.
export function flagRealConflictsWithVirtuals(
  reals: AppointmentRow[],
  virtuals: VirtualOccurrence[],
  nowMs: number,
): void {
  const conflicting = virtuals.filter((v) => v.in_conflict);
  if (conflicting.length === 0) return;

  for (const r of reals) {
    if (r.in_conflict) continue;
    if (!OPEN_STATES.has(r.state) || r.conflict_ignored) continue;
    const rStart = r.starts_at.getTime();
    if (rStart < nowMs) continue;
    const rEnd = rStart + r.duration_minutes * 60_000;

    for (const v of conflicting) {
      const sameOwner =
        v.professional_user_id === r.professional_user_id ||
        (r.resource_id != null && v.resource_id === r.resource_id);
      if (!sameOwner) continue;
      const vStart = new Date(v.starts_at).getTime();
      const vEnd = vStart + v.duration_minutes * 60_000;
      if (rStart < vEnd && rEnd > vStart) {
        r.in_conflict = true;
        break;
      }
    }
  }
}
