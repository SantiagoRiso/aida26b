import express from 'express';
import type { Request, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { sendData, sendError } from '../status_messages';
import { guardRoute } from '../helpers';
import type { AuthUser } from '../auth';
import { evaluateConflicts, resolveBooking, weekdayOf } from '../../../shared/src/ssot/domain';
import type { ConflictVerdict } from '../../../shared/src/ssot/domain';
import { getServiceDefaults, getClientOverridePrice } from '../db/catalog';
import { getBlockServiceForSlot, countAppointmentsHitByTimeOff } from '../db/scheduling';
import { assertOwnScheduleAllowed } from './crud-policy';
import { BUSINESS_TZ, DATE_RE, HHMM_RE, addMinutes, crossesMidnight } from '../time';
import {
  loadOwnerState,
  loadConflictInputs,
  toAggregatorOwner,
  resolveBookingWindow,
  isOutsideBookingWindow,
} from '../services/scheduling';
import type { ColumnValue } from '../../../shared/src/types/types';

type AuthedRequest = Request & { user?: AuthUser };

type AuditFn = (
  req: Request,
  eventType: string,
  outcome: string,
  details?: Record<string, ColumnValue>
) => Promise<void>;

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
    if (!fields.start && !fields.duration_minutes && crossesMidnight(start, durationMinutes)) {
      fields.duration_minutes = 'start + duration must not cross midnight';
    }
    if (Object.keys(fields).length > 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid conflict-check input', fields);
    }

    const serviceDefaults = await getServiceDefaults(pool, serviceId, businessId);
    if (serviceDefaults == null) {
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

    // Resolve price/duration BEFORE the conflict so the proposed interval and the service-sized grid
    // agree (a client's echoed body duration never wins; staff may set a sobreturno length).
    const callerIsStaff = user.role !== 'Client';
    const blockService = await getBlockServiceForSlot(pool, professionalUserId, serviceId, weekdayOf(date), start);
    const { effective_price, effective_duration_minutes } = resolveBooking({
      serviceDefaultPriceArs: serviceDefaults.default_price_ars,
      serviceDefaultDurationMinutes: serviceDefaults.default_duration_minutes,
      clientOverridePriceArs: overridePrice,
      blockServicePriceArs: blockService?.price_ars ?? null,
      blockServiceDurationMinutes: blockService?.duration_minutes ?? null,
      sobreturnoDurationMinutes: callerIsStaff ? durationMinutes : undefined,
    });

    const inputs = await loadConflictInputs(pool, businessId, { professionalUserId, resourceId, date, serviceId });
    if ('error' in inputs) {
      return sendError(res, inputs.error.status, inputs.error.code, inputs.error.message);
    }

    const end = addMinutes(start, effective_duration_minutes);
    const verdict: ConflictVerdict = evaluateConflicts({
      proposed: { start, end, date },
      callerIsStaff,
      excludeAppointmentId,
      professional: toAggregatorOwner(inputs.professional),
      resource: inputs.resource ? toAggregatorOwner(inputs.resource) : undefined,
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
    const serviceRaw = typeof req.query.service === 'string' ? Number(req.query.service) : NaN;
    const serviceId = Number.isInteger(serviceRaw) && serviceRaw > 0 ? serviceRaw : undefined;
    // A service yields service-sized bookable slots (SlotPicker); with none, a professional's raw
    // working windows are returned for the staff calendar's service-agnostic shading and snap grid.
    const excludeRaw = typeof req.query.exclude === 'string' ? Number(req.query.exclude) : NaN;
    const exclude = Number.isInteger(excludeRaw) && excludeRaw > 0 ? excludeRaw : undefined;
    const state = await loadOwnerState(pool, businessId, { kind, id: Number(owner![2]) }, date, {
      serviceId,
      excludeAppointmentId: exclude,
    });
    if (!state) return sendError(res, 404, 'not_found', 'Owner not found in this business');

    // Client self-service can't book outside the booking window — return no slots for those dates
    // so the picker offers nothing. Staff (calendar) are exempt and see real availability.
    if (user.role === 'Client' && kind === 'professional' && serviceId !== undefined) {
      const bounds = await resolveBookingWindow(pool, businessId, Number(owner![2]), serviceId);
      if (bounds && isOutsideBookingWindow(date, bounds)) {
        return sendData(res, { date, slots: [], open: false, outside_window: true });
      }
    }

    // `open` distinguishes "doesn't work that day" (false) from "works but fully booked"
    // (true + empty slots) so the UI can say which one it is.
    return sendData(res, { date, slots: state.freeSlots, open: state.gridSlots.length > 0 });
  }));

  // Concrete booking-window bounds for one (professional, service), so the client UI can clamp the
  // date picker and disable the next-day arrow past the window. Staff paths ignore it.
  app.get('/api/booking-window', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;
    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'A business context is required');
    }
    const professionalId = Number(req.query.professional);
    const serviceId = Number(req.query.service);
    const fields: Record<string, string> = {};
    if (!Number.isInteger(professionalId) || professionalId <= 0) fields.professional = 'required';
    if (!Number.isInteger(serviceId) || serviceId <= 0) fields.service = 'required';
    if (Object.keys(fields).length > 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid booking-window query', fields);
    }

    const bounds = await resolveBookingWindow(pool, user.business_id, professionalId, serviceId);
    if (!bounds) return sendError(res, 404, 'not_found', 'Professional not found in this business');
    return sendData(res, { min_date: bounds.minDate, max_date: bounds.maxDate });
  }));

  // How many open, future turnos a not-yet-saved time-off would put in conflict — read-only, backs
  // the warn-then-confirm dialog before adding a personal exception or a business closure. Naming a
  // professional_user_id previews a personal exception (gated like editing that schedule);
  // omitting it previews a whole-business closure (Admin only, mirroring the closures route).
  app.post('/api/time-off/conflict-preview', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;
    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'A business context is required');
    }
    const businessId = user.business_id;

    const body = req.body ?? {};
    const date = typeof body.date === 'string' ? body.date : '';
    if (!DATE_RE.test(date)) {
      return sendError(res, 422, 'invalid_request', 'date must be YYYY-MM-DD');
    }

    // Both-or-neither endpoints; absent ⇒ a full-day block.
    const start = body.start == null || body.start === '' ? null : String(body.start);
    const end = body.end == null || body.end === '' ? null : String(body.end);
    if ((start == null) !== (end == null)) {
      return sendError(res, 422, 'invalid_request', 'A time range needs both a start and an end');
    }
    if (start != null && end != null) {
      if (!HHMM_RE.test(start) || !HHMM_RE.test(end)) {
        return sendError(res, 422, 'invalid_request', 'Times must be HH:MM');
      }
      if (end <= start) {
        return sendError(res, 422, 'invalid_request', 'The end time must be after the start time');
      }
    }

    let scope: { kind: 'business' } | { kind: 'professional'; professionalUserId: number };
    const hasProf = body.professional_user_id != null && body.professional_user_id !== '';
    if (hasProf) {
      const professionalUserId = Number(body.professional_user_id);
      if (!Number.isInteger(professionalUserId) || professionalUserId <= 0) {
        return sendError(res, 422, 'invalid_request', 'professional_user_id must be a positive integer');
      }
      const allowed = await assertOwnScheduleAllowed(pool, user, { professional_user_id: professionalUserId });
      if (!allowed.ok) {
        return sendError(res, allowed.status, allowed.code, allowed.message);
      }
      scope = { kind: 'professional', professionalUserId };
    } else {
      if (user.role !== 'Admin') {
        return sendError(res, 403, 'forbidden', 'Only an Admin may preview a business closure');
      }
      scope = { kind: 'business' };
    }

    const count = await countAppointmentsHitByTimeOff(pool, businessId, BUSINESS_TZ, scope, { date, start, end });
    return sendData(res, { count });
  }));
}
