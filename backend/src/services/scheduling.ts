import type { PoolClient } from 'pg';
import { computeServiceSlots, computeFreeWindows, evaluateConflicts, weekdayOf } from '../../../shared/src/ssot/domain';
import type {
  TimeInterval,
  ServiceBlock,
  BookedAppointment,
  ConflictVerdict,
} from '../../../shared/src/ssot/domain';
import type { Queryable } from '../db/core';
import {
  getProfessionalOwner,
  getResourceOwner,
  getScheduleBlocksForService,
  getProfessionalBlocks,
  getResourceBlocks,
  getScheduleExceptions,
  getBusinessClosures,
  getBookedAppointments,
  getEffectiveBookingWindow,
  acquireOwnerLock,
} from '../db/scheduling';
import { BUSINESS_TZ, addMinutes, addDaysISO } from '../time';
import { httpError } from '../db/errors';

// Resources offer no services, so their blocks are bare windows; tile them at a fixed display
// granularity for the availability overlay. Conflict detection for a resource is containment-only
// (checkAlignment=false in evaluateConflicts), so this granularity never affects a save.
const RESOURCE_SLOT_MINUTES = 30;

// Domain orchestration with no HTTP surface, so both the scheduling routes and the appointment
// write path consume it from here rather than one route importing another.

// Client self-service is bounded by the effective booking window as concrete dates (today in
// business TZ + min/max days). null when the professional row is missing in the business (404).
// Staff paths skip this entirely; they may book any date.
export async function resolveBookingWindow(
  q: Queryable,
  businessId: number,
  professionalUserId: number,
  serviceId: number,
): Promise<{ minDate: string; maxDate: string | null } | null> {
  const window = await getEffectiveBookingWindow(q, professionalUserId, serviceId, businessId);
  if (!window) return null;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });
  return {
    minDate: addDaysISO(today, window.min_booking_days),
    maxDate: window.max_booking_days != null ? addDaysISO(today, window.max_booking_days) : null,
  };
}

export function isOutsideBookingWindow(
  date: string,
  bounds: { minDate: string; maxDate: string | null },
): boolean {
  return date < bounds.minDate || (bounds.maxDate !== null && date > bounds.maxDate);
}

export type OwnerState = {
  id: number;
  name: string;
  gridSlots: TimeInterval[]; // full grid (not minus booked) — feeds the conflict aggregator
  freeSlots: TimeInterval[]; // grid minus booked — feeds the availability endpoint
  booked: BookedAppointment[];
};

// Adapts DB state (name, weekly schedule, that date's exceptions, scheduled+requested appointments)
// into the pure aggregator's per-owner input. Business-scoped: returns null when the owner does not
// resolve within the caller's business (caller maps that to 404 to hide cross-tenant existence).
export async function loadOwnerState(
  q: Queryable,
  businessId: number,
  ref: { kind: 'professional' | 'resource'; id: number },
  date: string,
  opts: { serviceId?: number; excludeAppointmentId?: number } = {}
): Promise<OwnerState | null> {
  const ownerCol = ref.kind === 'professional' ? 'professional_user_id' : 'resource_id';
  const weekday = weekdayOf(date);

  let name: string;
  // Exactly one is set. Service-sized tiling for a chosen service (booking); service-agnostic free
  // windows for a professional with no service (the staff calendar's shading/lattice) and — via the
  // fixed resource grid — for resources.
  let serviceBlocks: ServiceBlock[] | null = null;
  let freeWindows: { start: string; end: string }[] | null = null;
  if (ref.kind === 'professional') {
    const row = await getProfessionalOwner(q, ref.id);
    if (!row || row.business_id == null || Number(row.business_id) !== businessId) return null;
    name = row.display_name;
    if (opts.serviceId) {
      // Each block's slot size is the service's effective duration inside that block (resolved in SQL).
      const rows = await getScheduleBlocksForService(q, ref.id, opts.serviceId, weekday);
      serviceBlocks = rows.map((b) => ({ start: b.start, end: b.end, slot_minutes: Number(b.slot_minutes) }));
    } else {
      // No chosen service: expose the working windows themselves, not bookable slots.
      freeWindows = await getProfessionalBlocks(q, ref.id, weekday);
    }
  } else {
    const row = await getResourceOwner(q, ref.id);
    if (!row || row.business_id == null || Number(row.business_id) !== businessId) return null;
    name = row.name;
    const rows = await getResourceBlocks(q, ref.id, weekday);
    serviceBlocks = rows.map((b) => ({ start: b.start, end: b.end, slot_minutes: RESOURCE_SLOT_MINUTES }));
  }

  // This owner's own exceptions plus any business-wide closure — a clinic closure blocks every
  // professional and resource, so it unions into each owner's unavailability the same way.
  const excRows = await getScheduleExceptions(q, ownerCol, ref.id, date);
  const closureRows = await getBusinessClosures(q, businessId, date);
  const exceptions = [...excRows, ...closureRows].map((e) => ({
    is_unavailable: e.is_unavailable,
    start_time: e.start_time,
    end_time: e.end_time,
    granularity_minutes: e.granularity_minutes,
  }));

  const apptRows = await getBookedAppointments(q, ownerCol, ref.id, date, BUSINESS_TZ);
  const booked: BookedAppointment[] = apptRows
    .filter((a) => opts.excludeAppointmentId === undefined || Number(a.id) !== opts.excludeAppointmentId)
    .map((a) => ({
      id: Number(a.id),
      start: a.start,
      end: a.end,
      state: a.state,
    }));
  const bookedIntervals: TimeInterval[] = booked.map((b) => ({ start: b.start, end: b.end }));

  const gridSlots = serviceBlocks
    ? computeServiceSlots({ blocks: serviceBlocks, exceptions })
    : computeFreeWindows({ blocks: freeWindows ?? [], exceptions });
  const freeSlots = serviceBlocks
    ? computeServiceSlots({ blocks: serviceBlocks, exceptions, booked: bookedIntervals })
    : computeFreeWindows({ blocks: freeWindows ?? [], exceptions, booked: bookedIntervals });

  return { id: ref.id, name, gridSlots, freeSlots, booked };
}

type LoaderError = { error: { status: number; code: string; message: string } };

export async function loadConflictInputs(
  q: Queryable,
  businessId: number,
  params: { professionalUserId: number; resourceId?: number; date: string; serviceId?: number }
): Promise<{ professional: OwnerState; resource?: OwnerState } | LoaderError> {
  const professional = await loadOwnerState(
    q,
    businessId,
    { kind: 'professional', id: params.professionalUserId },
    params.date,
    { serviceId: params.serviceId }
  );
  if (!professional) {
    return { error: { status: 404, code: 'not_found', message: 'Professional not found in this business' } };
  }

  let resource: OwnerState | undefined;
  if (params.resourceId !== undefined) {
    const r = await loadOwnerState(q, businessId, { kind: 'resource', id: params.resourceId }, params.date);
    if (!r) return { error: { status: 404, code: 'not_found', message: 'Resource not found in this business' } };
    resource = r;
  }

  return { professional, resource };
}

export function toAggregatorOwner(state: OwnerState) {
  return { id: state.id, name: state.name, slots: state.gridSlots, booked: state.booked };
}

// Advisory-lock namespaces so professional id N and resource id N never share a lock key.
const PROFESSIONAL_LOCK_NS = 1;
const RESOURCE_LOCK_NS = 2;

// The concurrency guarantee. Runs inside a caller-owned transaction (caller has
// already issued BEGIN and owns COMMIT/ROLLBACK). Takes a per-owner pg_advisory_xact_lock BEFORE
// loading state, then reuses the SAME loader + aggregator as the dry-run, so the recheck verdict
// is identical to the preview. Same-owner rechecks serialize; different owners proceed in
// parallel; the lock auto-releases on commit. Performs NO appointment write — the caller owns
// the write.
export async function recheckConflictsInTx(
  client: PoolClient,
  input: {
    businessId: number;
    professionalUserId: number;
    resourceId?: number;
    date: string;
    start: string;
    durationMinutes: number;
    serviceId: number;
    callerIsStaff: boolean;
    excludeAppointmentId?: number;
  }
): Promise<ConflictVerdict> {
  // Lock BEFORE any state read. Two-arg (classid, objid) form namespaces prof vs resource.
  await acquireOwnerLock(client, PROFESSIONAL_LOCK_NS, input.professionalUserId);
  if (input.resourceId !== undefined) {
    await acquireOwnerLock(client, RESOURCE_LOCK_NS, input.resourceId);
  }

  const inputs = await loadConflictInputs(client, input.businessId, {
    professionalUserId: input.professionalUserId,
    resourceId: input.resourceId,
    date: input.date,
    serviceId: input.serviceId,
  });
  if ('error' in inputs) {
    // Propagate the structured status/code so the caller maps "owner gone from tenant
    // between preview and recheck" to 404/409 rather than a generic 500.
    throw httpError(inputs.error.status, inputs.error.code, inputs.error.message);
  }

  const end = addMinutes(input.start, input.durationMinutes);
  return evaluateConflicts({
    proposed: { start: input.start, end, date: input.date },
    callerIsStaff: input.callerIsStaff,
    excludeAppointmentId: input.excludeAppointmentId,
    professional: toAggregatorOwner(inputs.professional),
    resource: inputs.resource ? toAggregatorOwner(inputs.resource) : undefined,
  });
}
