import express from 'express';
import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import { sendData, sendError } from '../status_messages';
import { guardRoute } from '../helpers';
import { authenticatedUser } from '../session';
import type { AuditWriter } from '../audit';
import { requireBusinessContext } from './business-context';
import { countAppointmentsHitByTimeOff } from '../db/scheduling';
import { assertOwnScheduleAllowed } from './crud-policy';
import { BUSINESS_TZ, DATE_RE, addDaysISO } from '../time';
import {
  loadOwnerState,
  resolveBookingWindow,
  isOutsideBookingWindow,
  parseTimeOffRange,
} from '../services/scheduling';
import { resolveAndLoadService, runConflictDryRun } from '../services/booking';
import { SCHEDULING_PATTERNS } from '../../../shared/src/ssot/api-paths';
import type {
  AvailabilityResult, BookingWindowResult, ConflictCheckResult, TimeOffConflictCountResult,
} from '../../../shared/src/ssot/contracts/scheduling';

export function mountSchedulingRoutes(
  app: express.Application,
  pool: Pool,
  guards: { auth: RequestHandler; passwordReady: RequestHandler; audit: AuditWriter }
) {
  // Advisory dry-run. REPORT-ONLY — never writes; appointments stay SELECT-only.
  app.post(SCHEDULING_PATTERNS.conflictCheck, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const body = req.body ?? {};
    const excludeAppointmentId =
      body.excludeAppointmentId == null ? undefined : Number(body.excludeAppointmentId);

    // A Client caller prices as themself when the body names no client; staff may name one.
    if (body.client_user_id == null && user.role === 'Client') {
      body.client_user_id = user.id;
    }

    // Price/duration resolve BEFORE the conflict so the proposed interval and the service-sized
    // grid agree (a client's echoed body duration never wins; staff may set a sobreturno length).
    const callerIsStaff = user.role !== 'Client';
    const resolved = await resolveAndLoadService(pool, businessId, body, callerIsStaff, 'Invalid conflict-check input');
    if (!resolved.ok) {
      return sendError(res, resolved.status, resolved.code, resolved.message, resolved.fields);
    }

    const dryRun = await runConflictDryRun(pool, businessId, {
      professionalUserId: resolved.professionalUserId,
      resourceId: resolved.resourceId,
      serviceId: resolved.serviceId,
      date: resolved.date,
      start: resolved.start,
      durationMinutes: resolved.effective_duration_minutes,
      callerIsStaff,
      excludeAppointmentId,
    });
    if (!dryRun.ok) {
      return sendError(res, dryRun.status, dryRun.code, dryRun.message);
    }

    const response = {
      ...dryRun.verdict,
      effective_price: resolved.effective_price,
      effective_duration_minutes: resolved.effective_duration_minutes,
    } satisfies ConflictCheckResult;
    return sendData(res, response);
  }));

  // Discrete free slots for one owner on one date. owner = prof:<id> | res:<id>.
  app.get(SCHEDULING_PATTERNS.availability, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const ownerToken = typeof req.query.owner === 'string' ? req.query.owner : '';
    const date = typeof req.query.date === 'string' ? req.query.date : '';
    const dateFrom = typeof req.query.date_from === 'string' ? req.query.date_from : '';
    const dateTo = typeof req.query.date_to === 'string' ? req.query.date_to : '';
    const rangeRequested = dateFrom !== '' || dateTo !== '';

    const fields: Record<string, string> = {};
    const owner = /^(prof|res):(\d+)$/.exec(ownerToken);
    if (!owner) fields.owner = 'must be prof:<id> or res:<id>';
    if (rangeRequested) {
      if (date !== '') fields.date = 'cannot be combined with date_from/date_to';
      if (!DATE_RE.test(dateFrom)) fields.date_from = 'must be YYYY-MM-DD';
      if (!DATE_RE.test(dateTo)) fields.date_to = 'must be YYYY-MM-DD';
      if (DATE_RE.test(dateFrom) && DATE_RE.test(dateTo) && dateTo <= dateFrom) {
        fields.date_to = 'must be after date_from';
      }
    } else if (!DATE_RE.test(date)) {
      fields.date = 'must be YYYY-MM-DD';
    }
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

    if (rangeRequested) {
      if (user.role === 'Client') {
        return sendError(res, 403, 'forbidden', 'Availability ranges are staff-only');
      }
      const dates: string[] = [];
      for (let current = dateFrom; current < dateTo && dates.length <= 42; current = addDaysISO(current, 1)) {
        dates.push(current);
      }
      if (dates.length > 42) {
        return sendError(res, 422, 'invalid_request', 'Availability range may not exceed 42 days');
      }
      const states = await Promise.all(dates.map((day) => loadOwnerState(
        pool,
        businessId,
        { kind, id: Number(owner![2]) },
        day,
        { excludeAppointmentId: exclude },
      )));
      if (states.some((state) => state == null)) {
        return sendError(res, 404, 'not_found', 'Owner not found in this business');
      }
      const response = states.map((state, index) => ({
        date: dates[index],
        slots: state!.freeSlots,
        open: state!.gridSlots.length > 0,
      } satisfies AvailabilityResult));
      return sendData(res, response);
    }

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
        const response = { date, slots: [], open: false, outside_window: true } satisfies AvailabilityResult;
        return sendData(res, response);
      }
    }

    // `open` distinguishes "doesn't work that day" (false) from "works but fully booked"
    // (true + empty slots) so the UI can say which one it is.
    const response = { date, slots: state.freeSlots, open: state.gridSlots.length > 0 } satisfies AvailabilityResult;
    return sendData(res, response);
  }));

  // Concrete booking-window bounds for one (professional, service), so the client UI can clamp the
  // date picker and disable the next-day arrow past the window. Staff paths ignore it.
  app.get(SCHEDULING_PATTERNS.bookingWindow, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;
    const professionalId = Number(req.query.professional);
    const serviceId = Number(req.query.service);
    const fields: Record<string, string> = {};
    if (!Number.isInteger(professionalId) || professionalId <= 0) fields.professional = 'required';
    if (!Number.isInteger(serviceId) || serviceId <= 0) fields.service = 'required';
    if (Object.keys(fields).length > 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid booking-window query', fields);
    }

    const bounds = await resolveBookingWindow(pool, businessId, professionalId, serviceId);
    if (!bounds) return sendError(res, 404, 'not_found', 'Professional not found in this business');
    const response = { min_date: bounds.minDate, max_date: bounds.maxDate } satisfies BookingWindowResult;
    return sendData(res, response);
  }));

  // How many open, future turnos a not-yet-saved time-off would put in conflict — read-only, backs
  // the warn-then-confirm dialog before adding a personal exception or a business closure. Naming a
  // professional_user_id previews a personal exception (gated like editing that schedule);
  // omitting it previews a whole-business closure (Admin only, mirroring the closures route).
  app.post(SCHEDULING_PATTERNS.timeOffConflictPreview, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const body = req.body ?? {};
    const parsed = parseTimeOffRange(
      { date: body.date, start: body.start, end: body.end },
      { status: 422, message: 'date must be YYYY-MM-DD' },
    );
    if (!parsed.ok) {
      return sendError(res, parsed.status, parsed.code, parsed.message);
    }
    const { date, start, end } = parsed;

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
    return sendData(res, { count } satisfies TimeOffConflictCountResult);
  }));
}
