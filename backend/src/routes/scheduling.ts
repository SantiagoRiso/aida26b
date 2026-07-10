import express from 'express';
import type { Request, RequestHandler } from 'express';
import type { Pool, PoolClient } from 'pg';
import { sendData, sendError } from '../status_messages';
import { guardRoute } from '../helpers';
import type { AuthUser } from '../auth';
import {
  computeDailySlots,
  evaluateConflicts,
  resolveBooking,
} from '../../../shared/src/ssot/domain';
import type {
  TimeInterval,
  BookedAppointment,
  ConflictVerdict,
} from '../../../shared/src/ssot/domain';
import type { Queryable } from '../db/core';
import {
  getProfessionalOwner,
  getResourceOwner,
  getWeeklySchedule,
  getScheduleExceptions,
  getBookedAppointments,
  acquireOwnerLock,
} from '../db/scheduling';
import { getServiceDefaultPrice, getClientOverridePrice } from '../db/catalog';
import type { ColumnValue } from '../../../shared/src/types/types';

type AuthedRequest = Request & { user?: AuthUser };

type AuditFn = (
  req: Request,
  eventType: string,
  outcome: string,
  details?: Record<string, ColumnValue>
) => Promise<void>;

// Argentina-only (UTC-3, no DST), matching the offset constant in shared validate.ts.
// Appointment starts_at/ends_at are TIMESTAMPTZ; slots and schedules are local wall-clock HH:MM.
const BUSINESS_TZ = 'America/Argentina/Buenos_Aires';

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
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
async function loadOwnerState(
  q: Queryable,
  businessId: number,
  ref: { kind: 'professional' | 'resource'; id: number },
  date: string,
  excludeAppointmentId?: number
): Promise<OwnerState | null> {
  let name: string;
  if (ref.kind === 'professional') {
    const row = await getProfessionalOwner(q, ref.id);
    if (!row || row.business_id == null || Number(row.business_id) !== businessId) return null;
    name = row.display_name;
  } else {
    const row = await getResourceOwner(q, ref.id);
    if (!row || row.business_id == null || Number(row.business_id) !== businessId) return null;
    name = row.name;
  }

  const ownerCol = ref.kind === 'professional' ? 'professional_user_id' : 'resource_id';

  const weekly = await getWeeklySchedule(q, ownerCol, ref.id);

  const excRows = await getScheduleExceptions(q, ownerCol, ref.id, date);
  const exceptions = excRows.map((e) => ({
    is_unavailable: e.is_unavailable,
    start_time: e.start_time,
    end_time: e.end_time,
    granularity_minutes: e.granularity_minutes,
  }));

  const apptRows = await getBookedAppointments(q, ownerCol, ref.id, date, BUSINESS_TZ);
  const booked: BookedAppointment[] = apptRows
    .filter((a) => excludeAppointmentId === undefined || Number(a.id) !== excludeAppointmentId)
    .map((a) => ({
      id: Number(a.id),
      start: a.start,
      end: a.end,
      state: a.state,
    }));

  const gridSlots = computeDailySlots({ date, weekly, exceptions });
  const freeSlots = computeDailySlots({
    date,
    weekly,
    exceptions,
    booked: booked.map((b) => ({ start: b.start, end: b.end })),
  });

  return { id: ref.id, name, gridSlots, freeSlots, booked };
}

type LoaderError = { error: { status: number; code: string; message: string } };

export async function loadConflictInputs(
  q: Queryable,
  businessId: number,
  params: { professionalUserId: number; resourceId?: number; date: string }
): Promise<{ professional: OwnerState; resource?: OwnerState } | LoaderError> {
  const professional = await loadOwnerState(
    q,
    businessId,
    { kind: 'professional', id: params.professionalUserId },
    params.date
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

function toAggregatorOwner(state: OwnerState) {
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
  });
  if ('error' in inputs) {
    // Propagate the structured status/code so the caller maps "owner gone from tenant
    // between preview and recheck" to 404/409 rather than a generic 500.
    const err = new Error(inputs.error.message) as Error & { status?: number; code?: string };
    err.status = inputs.error.status;
    err.code = inputs.error.code;
    throw err;
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

export function mountSchedulingRoutes(
  app: express.Application,
  pool: Pool,
  guards: { auth: RequestHandler; passwordReady: RequestHandler; audit: AuditFn }
) {
  // Advisory dry-run. REPORT-ONLY — never writes; appointments stay SELECT-only.
  app.post('/api/conflict-check', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;
    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'A business context is required to check conflicts');
    }
    const businessId = user.business_id;

    const body = req.body ?? {};
    const professionalUserId = Number(body.professional_user_id);
    const resourceId =
      body.resource_id == null || body.resource_id === '' ? undefined : Number(body.resource_id);
    const serviceId = Number(body.service_id);
    const date = typeof body.date === 'string' ? body.date : '';
    const start = typeof body.start === 'string' ? body.start : '';
    const durationMinutes = Number(body.duration_minutes);
    const excludeAppointmentId =
      body.excludeAppointmentId == null ? undefined : Number(body.excludeAppointmentId);

    const fields: Record<string, string> = {};
    if (!Number.isInteger(professionalUserId) || professionalUserId <= 0) fields.professional_user_id = 'required';
    if (resourceId !== undefined && (!Number.isInteger(resourceId) || resourceId <= 0)) fields.resource_id = 'must be a valid id';
    if (!Number.isInteger(serviceId) || serviceId <= 0) fields.service_id = 'required';
    if (!DATE_RE.test(date)) fields.date = 'must be YYYY-MM-DD';
    if (!HHMM_RE.test(start)) fields.start = 'must be HH:MM';
    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) fields.duration_minutes = 'must be a positive integer';
    // A same-day appointment cannot cross midnight; reject rather than roll HH:MM past 24:00.
    if (!fields.start && !fields.duration_minutes) {
      const startMin = Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5));
      if (startMin + durationMinutes > 24 * 60) fields.duration_minutes = 'start + duration must not cross midnight';
    }
    if (Object.keys(fields).length > 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid conflict-check input', fields);
    }

    const inputs = await loadConflictInputs(pool, businessId, { professionalUserId, resourceId, date });
    if ('error' in inputs) {
      return sendError(res, inputs.error.status, inputs.error.code, inputs.error.message);
    }

    const serviceDefaultPriceArs = await getServiceDefaultPrice(pool, serviceId, businessId);
    if (serviceDefaultPriceArs == null) {
      return sendError(res, 404, 'not_found', 'Service not found in this business');
    }

    // Per-client override, when the client is known (Client caller = self; staff may name one).
    // Business-scope the client too, so a body-supplied cross-tenant client id can't surface a price.
    const clientUserId =
      body.client_user_id != null ? Number(body.client_user_id) : user.role === 'Client' ? user.id : null;
    let overridePrice: string | null = null;
    if (clientUserId != null && Number.isInteger(clientUserId)) {
      overridePrice = await getClientOverridePrice(pool, clientUserId, professionalUserId, serviceId, businessId);
    }

    const end = addMinutes(start, durationMinutes);
    const verdict: ConflictVerdict = evaluateConflicts({
      proposed: { start, end, date },
      callerIsStaff: user.role !== 'Client',
      excludeAppointmentId,
      professional: toAggregatorOwner(inputs.professional),
      resource: inputs.resource ? toAggregatorOwner(inputs.resource) : undefined,
    });

    const { effective_price, effective_duration_minutes } = resolveBooking({
      serviceDefaultPriceArs,
      clientOverridePriceArs: overridePrice,
      slotGranularityMinutes: durationMinutes,
    });

    return sendData(res, { ...verdict, effective_price, effective_duration_minutes });
  }));

  // Discrete free slots for one owner on one date. owner = prof:<id> | res:<id>.
  app.get('/api/availability', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;
    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'A business context is required to read availability');
    }
    const businessId = user.business_id;

    const ownerToken = typeof req.query.owner === 'string' ? req.query.owner : '';
    const date = typeof req.query.date === 'string' ? req.query.date : '';

    const fields: Record<string, string> = {};
    const owner = /^(prof|res):(\d+)$/.exec(ownerToken);
    if (!owner) fields.owner = 'must be prof:<id> or res:<id>';
    if (!DATE_RE.test(date)) fields.date = 'must be YYYY-MM-DD';
    if (Object.keys(fields).length > 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid availability query', fields);
    }

    const kind = owner![1] === 'prof' ? 'professional' : 'resource';
    const excludeRaw = typeof req.query.exclude === 'string' ? Number(req.query.exclude) : NaN;
    const exclude = Number.isInteger(excludeRaw) && excludeRaw > 0 ? excludeRaw : undefined;
    const state = await loadOwnerState(pool, businessId, { kind, id: Number(owner![2]) }, date, exclude);
    if (!state) return sendError(res, 404, 'not_found', 'Owner not found in this business');

    // `open` distinguishes "doesn't work that day" (false) from "works but fully booked"
    // (true + empty slots) so the UI can say which one it is.
    return sendData(res, { date, slots: state.freeSlots, open: state.gridSlots.length > 0 });
  }));
}
