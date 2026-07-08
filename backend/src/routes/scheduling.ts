import express from 'express';
import type { Request, RequestHandler } from 'express';
import { Pool, PoolClient } from 'pg';
import { sendData, sendError } from '../status_messages';
import type { AuthUser } from '../auth';
import {
  computeDailySlots,
  evaluateConflicts,
  resolveBooking,
} from '../../../shared/src/ssot/domain';
import type {
  WeeklySchedule,
  TimeInterval,
  BookedAppointment,
  ConflictVerdict,
} from '../../../shared/src/ssot/domain';

type AuthedRequest = Request & { user?: AuthUser };

type AuditFn = (
  req: Request,
  eventType: string,
  outcome: string,
  details?: Record<string, unknown>
) => Promise<void>;

// A pg Pool or a transaction-bound client — the dry-run runs on the pool, the transactional
// recheck (Plan 03) binds the same loader to the tx client so both share one code path.
type Queryable = Pool | PoolClient;

// D1 is Argentina-only (UTC-3, no DST), matching the offset constant in shared validate.ts.
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
    const r = await q.query<{ display_name: string; business_id: string | null }>(
      `SELECT display_name, business_id FROM auth.users
       WHERE id = $1 AND role = 'Professional' AND is_active = true`,
      [ref.id]
    );
    const row = r.rows[0];
    if (!row || row.business_id == null || Number(row.business_id) !== businessId) return null;
    name = row.display_name;
  } else {
    const r = await q.query<{ name: string; business_id: string | null }>(
      `SELECT name, business_id FROM resources WHERE id = $1 AND deleted_at IS NULL`,
      [ref.id]
    );
    const row = r.rows[0];
    if (!row || row.business_id == null || Number(row.business_id) !== businessId) return null;
    name = row.name;
  }

  // Column name is code-controlled (never user input), so interpolation here is injection-safe.
  const ownerCol = ref.kind === 'professional' ? 'professional_user_id' : 'resource_id';

  const sched = await q.query<{ weekly: unknown }>(
    `SELECT weekly FROM schedules WHERE ${ownerCol} = $1`,
    [ref.id]
  );
  const weekly = (sched.rows[0]?.weekly ?? {}) as WeeklySchedule;

  const exc = await q.query<{
    is_unavailable: boolean;
    start_time: string | null;
    end_time: string | null;
    granularity_minutes: number | null;
  }>(
    `SELECT is_unavailable,
            to_char(start_time, 'HH24:MI') AS start_time,
            to_char(end_time,   'HH24:MI') AS end_time,
            granularity_minutes
     FROM schedule_exceptions
     WHERE ${ownerCol} = $1 AND exception_date = $2::date`,
    [ref.id, date]
  );
  const exceptions = exc.rows.map((e) => ({
    is_unavailable: e.is_unavailable,
    start_time: e.start_time,
    end_time: e.end_time,
    granularity_minutes: e.granularity_minutes,
  }));

  const appts = await q.query<{ id: string; start: string; end: string; state: 'scheduled' | 'requested' }>(
    `SELECT id,
            to_char(starts_at AT TIME ZONE $2, 'HH24:MI') AS start,
            to_char(ends_at   AT TIME ZONE $2, 'HH24:MI') AS "end",
            state
     FROM appointments
     WHERE ${ownerCol} = $1
       AND state IN ('scheduled', 'requested')
       AND (starts_at AT TIME ZONE $2)::date = $3::date`,
    [ref.id, BUSINESS_TZ, date]
  );
  const booked: BookedAppointment[] = appts.rows
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

// The concurrency guarantee (D-01/D-02). Runs inside a caller-owned transaction (caller has
// already issued BEGIN and owns COMMIT/ROLLBACK). Takes a per-owner pg_advisory_xact_lock BEFORE
// loading state, then reuses the SAME loader + aggregator as the dry-run, so the recheck verdict
// is identical to the preview. Same-owner rechecks serialize; different owners proceed in
// parallel; the lock auto-releases on commit. Performs NO appointment write — Phase 4 wires this
// into the real save.
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
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [PROFESSIONAL_LOCK_NS, input.professionalUserId]);
  if (input.resourceId !== undefined) {
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [RESOURCE_LOCK_NS, input.resourceId]);
  }

  const inputs = await loadConflictInputs(client, input.businessId, {
    professionalUserId: input.professionalUserId,
    resourceId: input.resourceId,
    date: input.date,
  });
  if ('error' in inputs) {
    // Propagate the structured status/code so the Phase 4 save maps "owner gone from tenant
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
  // Advisory dry-run (D-01/D-03/D-14). REPORT-ONLY — never writes; appointments stay SELECT-only.
  app.post('/api/conflict-check', guards.auth, guards.passwordReady, async (req, res) => {
    const user = (req as AuthedRequest).user!;
    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'A business context is required to check conflicts');
    }

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

    const inputs = await loadConflictInputs(pool, user.business_id, { professionalUserId, resourceId, date });
    if ('error' in inputs) {
      return sendError(res, inputs.error.status, inputs.error.code, inputs.error.message);
    }

    const svc = await pool.query<{ default_price_ars: string }>(
      `SELECT default_price_ars FROM services WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`,
      [serviceId, user.business_id]
    );
    if (svc.rows.length === 0) {
      return sendError(res, 404, 'not_found', 'Service not found in this business');
    }

    // Per-client override, when the client is known (Client caller = self; staff may name one).
    const clientUserId =
      body.client_user_id != null ? Number(body.client_user_id) : user.role === 'Client' ? user.id : null;
    let overridePrice: string | null = null;
    if (clientUserId != null && Number.isInteger(clientUserId)) {
      // Business-scope the client too, so a body-supplied cross-tenant client id can't surface a
      // price. professional_user_id/service_id are already tenant-validated above.
      const ov = await pool.query<{ price_ars: string }>(
        `SELECT cps.price_ars
         FROM client_professional_services cps
         JOIN auth.users u ON u.id = cps.client_user_id
         WHERE cps.client_user_id = $1 AND cps.professional_user_id = $2 AND cps.service_id = $3
           AND u.business_id = $4`,
        [clientUserId, professionalUserId, serviceId, user.business_id]
      );
      overridePrice = ov.rows[0]?.price_ars ?? null;
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
      serviceDefaultPriceArs: svc.rows[0].default_price_ars,
      clientOverridePriceArs: overridePrice,
      slotGranularityMinutes: durationMinutes,
    });

    return sendData(res, { ...verdict, effective_price, effective_duration_minutes });
  });

  // Discrete free slots for one owner on one date (D-15). owner = prof:<id> | res:<id>.
  app.get('/api/availability', guards.auth, guards.passwordReady, async (req, res) => {
    const user = (req as AuthedRequest).user!;
    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'A business context is required to read availability');
    }

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
    const state = await loadOwnerState(pool, user.business_id, { kind, id: Number(owner![2]) }, date, exclude);
    if (!state) return sendError(res, 404, 'not_found', 'Owner not found in this business');

    return sendData(res, { date, slots: state.freeSlots });
  });
}
