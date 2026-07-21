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
import { BUSINESS_TZ, addDaysISO } from '../time';
import {
  parseRequestFields,
  requireRequestFields,
  requestIssue,
  sendFieldIssues,
  type RequestIssues,
  type RequestSpec,
} from './request-guards';
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

// A calendar owner is addressed as prof:<id> or res:<id> in one opaque param.
const OWNER_TOKEN_RE = /^(prof|res):(\d+)$/;

const AVAILABILITY_OWNER_QUERY = {
  owner: { kind: 'pattern', pattern: OWNER_TOKEN_RE, key: 'ownerToken', required: true },
} as const satisfies RequestSpec;

// `service` and `exclude` narrow the answer but never define it: an unusable value degrades to
// the service-agnostic view rather than failing the request, so they stay outside the shape check.
function optionalId(raw: express.Request['query'][string]): number | undefined {
  const parsed = typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

const AVAILABILITY_DAY_QUERY = {
  date: { kind: 'isoDate', required: true },
} as const satisfies RequestSpec;

const AVAILABILITY_RANGE_QUERY = {
  date_from: { kind: 'isoDate', required: true },
  date_to: { kind: 'isoDate', required: true },
} as const satisfies RequestSpec;

const BOOKING_WINDOW_QUERY = {
  professional: { kind: 'id', required: true },
  service: { kind: 'id', required: true },
} as const satisfies RequestSpec;

const TIME_OFF_PREVIEW_BODY = {
  professional_user_id: { kind: 'id' },
} as const satisfies RequestSpec;

// An availability range is expanded day by day; a wider span would scan without bound.
const MAX_AVAILABILITY_RANGE_DAYS = 42;

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
      return sendError(res, resolved.status, resolved.code, resolved.message, { fields: resolved.fields, fieldDetails: resolved.fieldDetails });
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

    // A range and a single date are alternative modes, so which fields are required depends on
    // which one the caller asked for; the two specs' issues merge into one response.
    const rangeRequested = req.query.date_from != null || req.query.date_to != null;

    const ownerQuery = parseRequestFields(AVAILABILITY_OWNER_QUERY, req.query);
    const range = rangeRequested ? parseRequestFields(AVAILABILITY_RANGE_QUERY, req.query) : null;
    const single = rangeRequested ? null : parseRequestFields(AVAILABILITY_DAY_QUERY, req.query);

    const issues: RequestIssues = { ...ownerQuery.issues, ...range?.issues, ...single?.issues };
    if (range) {
      if (req.query.date != null) {
        issues.date = requestIssue('notAllowedWithRange', 'cannot be combined with date_from/date_to');
      }
      const { date_from: from, date_to: to } = range.values;
      if (!issues.date_from && !issues.date_to) {
        if (to <= from) issues.date_to = requestIssue('dateRangeOrder', 'must be after date_from');
        else if (addDaysISO(from, MAX_AVAILABILITY_RANGE_DAYS) < to) {
          issues.date_to = requestIssue(
            'dateRangeTooLong',
            `range may not exceed ${MAX_AVAILABILITY_RANGE_DAYS} days`,
            { max: MAX_AVAILABILITY_RANGE_DAYS },
          );
        }
      }
    }
    if (Object.keys(issues).length > 0) {
      return sendFieldIssues(res, 'Invalid availability query', issues);
    }

    const owner = OWNER_TOKEN_RE.exec(ownerQuery.values.owner);
    // Shape already checked above; the re-match only recovers the captured groups.
    if (!owner) return sendFieldIssues(res, 'Invalid availability query', {
      owner: requestIssue('ownerToken', 'must be prof:<id> or res:<id>'),
    });

    const kind = owner[1] === 'prof' ? 'professional' : 'resource';
    const ownerId = Number(owner[2]);
    // A service yields service-sized bookable slots (SlotPicker); with none, a professional's raw
    // working windows are returned for the staff calendar's service-agnostic shading and snap grid.
    const serviceId = optionalId(req.query.service);
    const exclude = optionalId(req.query.exclude);

    if (range) {
      const { date_from: dateFrom, date_to: dateTo } = range.values;
      if (user.role === 'Client') {
        return sendError(res, 403, 'forbidden', 'Availability ranges are staff-only');
      }
      const dates: string[] = [];
      for (let current = dateFrom; current < dateTo; current = addDaysISO(current, 1)) {
        dates.push(current);
      }
      const states = await Promise.all(dates.map((each) => loadOwnerState(
        pool,
        businessId,
        { kind, id: ownerId },
        each,
        { excludeAppointmentId: exclude },
      )));
      if (states.some((state) => state == null)) {
        return sendError(res, 404, 'not_found', 'Owner not found in this business');
      }
      const response = states.map((state, index) => {
        if (!state) throw new Error('Owner state disappeared after validation');
        return {
          date: dates[index],
          slots: state.freeSlots,
          open: state.gridSlots.length > 0,
        } satisfies AvailabilityResult;
      });
      return sendData(res, response);
    }

    // Range mode has already returned; single-date mode parsed and required `date` above.
    const date = single?.values.date ?? '';
    const state = await loadOwnerState(pool, businessId, { kind, id: ownerId }, date, {
      serviceId,
      excludeAppointmentId: exclude,
    });
    if (!state) return sendError(res, 404, 'not_found', 'Owner not found in this business');

    // Client self-service can't book outside the booking window — return no slots for those dates
    // so the picker offers nothing. Staff (calendar) are exempt and see real availability.
    if (user.role === 'Client' && kind === 'professional' && serviceId !== undefined) {
      const bounds = await resolveBookingWindow(pool, businessId, ownerId, serviceId);
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
    const query = requireRequestFields(res, BOOKING_WINDOW_QUERY, req.query, 'Invalid booking-window query');
    if (!query) return;
    const { professional: professionalId, service: serviceId } = query;

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
      { status: 422, message: 'date must be YYYY-MM-DD', key: 'dateFormat' },
    );
    if (!parsed.ok) {
      return sendError(res, parsed.status, parsed.code, parsed.message, { detail: parsed.detail });
    }
    const { date, start, end } = parsed;

    const scoped = requireRequestFields(res, TIME_OFF_PREVIEW_BODY, body, 'Invalid time-off preview');
    if (!scoped) return;

    let scope: { kind: 'business' } | { kind: 'professional'; professionalUserId: number };
    const professionalUserId = scoped.professional_user_id;
    if (professionalUserId !== undefined) {
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
