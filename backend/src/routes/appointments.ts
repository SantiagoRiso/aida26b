import express from 'express';
import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import { sendData, sendError, sendList } from '../status_messages';
import { guardRoute } from '../helpers';
import { authenticatedUser } from '../session';
import type { AuditWriter } from '../audit';
import { requireBusinessContext } from './business-context';
import {
  TERMINAL_STATES,
  APPOINTMENT_STATE_VALUES,
  assertValidTransition,
  canCancelAppointment,
  canMarkNoShow,
  canCompleteAppointment,
  DEFAULT_CANCELLATION_CUTOFF_HOURS,
  expandSeries,
  seriesRuleFromRow,
  parseRecurrenceRule,
  type RecurrenceRuleFields,
  type Conflict,
} from '../../../shared/src/ssot/domain';
import { BUSINESS_TZ, DATE_OR_ISO_RE, DATE_RE, addDaysISO, toBusinessDate } from '../time';
import { httpError } from '../errors';
import { assertAppointmentActionAllowed, auditInTx, auditConflictOverrideInTx } from './appointment-authz';
import { withTransaction } from '../db/core';
import { resolveBookingWindow, isOutsideBookingWindow } from '../services/scheduling';
import {
  loadAppointment,
  getAppointmentWallClock,
  insertRequestedAppointment,
  insertScheduledAppointment,
  approveAppointment,
  rescheduleAppointment,
  transitionAppointmentState,
  patchAppointmentFields,
  setAppointmentConflictIgnored,
  listAppointments,
  listRelatedClientIds,
  type AppointmentRoleScope,
} from '../db/appointments';
import { resolveAndLoadService, runConflictDryRun, saveWithConflictRecheck } from '../services/booking';
import { insertSessionChargeIfAbsent } from '../db/ledger';
import { getCancellationCutoffHours } from '../db/businesses';
import {
  insertSeries,
  getSeriesById,
  updateSeriesRule,
  endSeriesAt,
  cancelFutureOccurrences,
  type InsertSeriesInput,
} from '../db/series';
import { canMaterializeOccurrence, ensureOccurrenceMaterialized } from '../services/series-materialize';
import { listVirtualOccurrences, flagRealConflictsWithVirtuals } from '../services/series-listing';
import type { AppointmentRow, AppointmentSeriesRow, ListAppointment } from '../../../shared/src/ssot/query-types';
import type {
  EndSeriesResult, MaterializedOccurrenceResult, RelatedClientIdsResult,
  ScheduleSeriesResult, SeriesResult, SplitSeriesResult,
} from '../../../shared/src/ssot/contracts/appointments';
import { parsePagination } from './pagination';
import { APPOINTMENT_PATTERNS } from '../../../shared/src/ssot/api-paths';

// Occurrences generated for the create-time preview span this many days from max(start_date,
// today) — bounded so a preview never dry-runs an unbounded (open-ended) series.
const SERIES_PREVIEW_DAYS = 56;

// eslint-disable-next-line no-restricted-syntax -- Narrows an untrusted request-body field.
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function stripStaffFields(row: AppointmentRow): Omit<AppointmentRow, 'staff_note' | 'override_actor_id'> {
  const { staff_note: _staffNote, override_actor_id: _overrideActorId, ...safe } = row;
  return safe;
}

export function mountAppointmentRoutes(
  app: express.Application,
  pool: Pool,
  guards: { auth: RequestHandler; passwordReady: RequestHandler; audit: AuditWriter },
) {
  app.post(APPOINTMENT_PATTERNS.request, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);

    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;
    if (user.role !== 'Client') {
      return sendError(res, 403, 'forbidden', 'Only clients may use the request endpoint');
    }

    const body = req.body ?? {};
    // Client is always the caller; ignore any body-supplied client_user_id.
    body.client_user_id = user.id;

    const resolved = await resolveAndLoadService(pool, businessId, body, false);
    if (!resolved.ok) {
      return sendError(res, resolved.status, resolved.code, resolved.message, { fields: resolved.fields, fieldDetails: resolved.fieldDetails });
    }

    const {
      professionalUserId,
      serviceId,
      date,
      start,
      effective_duration_minutes,
      effective_price,
      name,
      description,
      startsAt,
    } = resolved;

    // Client self-service is bounded by the effective booking window; staff paths stay exempt.
    const bounds = await resolveBookingWindow(pool, businessId, professionalUserId, serviceId);
    if (bounds && isOutsideBookingWindow(date, bounds)) {
      return sendError(res, 422, 'outside_booking_window',
        `Requests are allowed from ${bounds.minDate}${bounds.maxDate !== null ? ` to ${bounds.maxDate}` : ''}`);
    }

    // Dry-run conflict check — read-only, no advisory lock needed for a mere read.
    const dryRun = await runConflictDryRun(pool, businessId, {
      professionalUserId,
      serviceId,
      date,
      start,
      durationMinutes: effective_duration_minutes,
      callerIsStaff: false,
    });
    if (!dryRun.ok) {
      return sendError(res, dryRun.status, dryRun.code, dryRun.message);
    }

    if (dryRun.verdict.requires_override) {
      // Clients can never override.
      return sendData(res, dryRun.verdict);
    }

    const appt = await withTransaction(pool, async (tx) => {
      const inserted = await insertRequestedAppointment(tx, {
        clientUserId: user.id,
        professionalUserId,
        serviceId,
        startsAt,
        durationMinutes: effective_duration_minutes,
        price: effective_price,
        name,
        description,
      });
      await auditInTx(tx, user, 'appointment_requested', 'success', Number(inserted.id));
      return inserted;
    });

    return sendData(res, stripStaffFields(appt), 201);
  }));

  app.post(APPOINTMENT_PATTERNS.schedule, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);

    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const body = req.body ?? {};
    const professionalUserId = Number(body.professional_user_id);

    const authz = await assertAppointmentActionAllowed(pool, user, professionalUserId);
    if (!authz.ok) {
      await guards.audit(req, 'appointment_action_denied', 'denied', {
        reason: authz.code,
        professional_user_id: professionalUserId,
      });
      return sendError(res, authz.status, authz.code, authz.message);
    }

    const resolved = await resolveAndLoadService(pool, businessId, body, true);
    if (!resolved.ok) {
      return sendError(res, resolved.status, resolved.code, resolved.message, { fields: resolved.fields, fieldDetails: resolved.fieldDetails });
    }

    const {
      serviceId,
      date,
      start,
      effective_duration_minutes,
      effective_price,
      resourceId,
      clientUserId,
      name,
      description,
      startsAt,
    } = resolved;

    const override = req.body.override === true;

    const outcome = await saveWithConflictRecheck(
      pool,
      { businessId, professionalUserId, resourceId, date, start, durationMinutes: effective_duration_minutes, serviceId },
      override,
      async (tx, forced) => {
        // client_user_id is NOT NULL — checked here (inside the write, after the recheck) so a staff
        // caller probing a conflicting slot without a chosen client still sees the verdict first.
        if (!isPositiveInteger(clientUserId)) {
          throw httpError(422, 'invalid_request', 'Invalid appointment input', { client_user_id: 'required' });
        }
        // `forced` marks a sobreturno — an override that bypassed a real conflict; a redundant
        // override flag on a clean booking must not mark the row.
        const appt = await insertScheduledAppointment(tx, {
          clientUserId,
          professionalUserId,
          resourceId: resourceId ?? null,
          serviceId,
          startsAt,
          durationMinutes: effective_duration_minutes,
          price: effective_price,
          overrideConflict: forced,
          overrideActorId: forced ? user.id : null,
          name,
          description,
        });
        await auditInTx(tx, user, 'appointment_scheduled', 'success', Number(appt.id));
        if (forced) await auditConflictOverrideInTx(tx, user, Number(appt.id), 'schedule');
        return appt;
      },
    );

    if (outcome.kind === 'verdict') return sendData(res, outcome.verdict);
    return sendData(res, outcome.result, 201);
  }));

  app.post(APPOINTMENT_PATTERNS.approve, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid appointment id');
    }

    const row = await loadAppointment(pool, id, businessId);
    if (!row) return sendError(res, 404, 'not_found', 'Appointment not found');

    const authz = await assertAppointmentActionAllowed(pool, user, Number(row.professional_user_id));
    if (!authz.ok) {
      await guards.audit(req, 'appointment_action_denied', 'denied', { reason: authz.code, entity_id: id });
      return sendError(res, authz.status, authz.code, authz.message);
    }

    if (row.state !== 'requested') {
      return sendError(res, 422, 'invalid_transition', `Approve is only valid from state 'requested'; current state is '${String(row.state)}'`);
    }

    const override = req.body?.override === true;
    const resourceId =
      row.resource_id == null ? undefined : Number(row.resource_id);

    const wall = await getAppointmentWallClock(pool, id, BUSINESS_TZ);
    if (!wall) return sendError(res, 404, 'not_found', 'Appointment not found');
    const dateStr = wall.date;
    const startStr = wall.start;

    const outcome = await saveWithConflictRecheck(
      pool,
      {
        businessId,
        professionalUserId: Number(row.professional_user_id),
        resourceId,
        date: dateStr,
        start: startStr,
        durationMinutes: Number(row.duration_minutes),
        serviceId: Number(row.service_id),
        excludeAppointmentId: id,
      },
      override,
      async (tx, forced) => {
        const appt = await approveAppointment(tx, id, {
          overrideConflict: forced,
          overrideActorId: forced ? user.id : (row.override_actor_id ?? null),
        });
        if (!appt) throw httpError(404, 'not_found', 'Appointment not found');
        await auditInTx(tx, user, 'appointment_approved', 'success', id);
        if (forced) await auditConflictOverrideInTx(tx, user, id, 'approve');
        return appt;
      },
    );

    if (outcome.kind === 'verdict') return sendData(res, outcome.verdict);
    return sendData(res, outcome.result);
  }));

  app.post(APPOINTMENT_PATTERNS.reschedule, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid appointment id');
    }

    const row = await loadAppointment(pool, id, businessId);
    if (!row) return sendError(res, 404, 'not_found', 'Appointment not found');

    // Authz before state check: unauthorized callers get 403 regardless of the appointment's
    // state — prevents probing terminal vs. actionable via 422 vs. 403.
    const authz = await assertAppointmentActionAllowed(pool, user, Number(row.professional_user_id));
    if (!authz.ok) {
      await guards.audit(req, 'appointment_action_denied', 'denied', { reason: authz.code, entity_id: id });
      return sendError(res, authz.status, authz.code, authz.message);
    }

    if (TERMINAL_STATES.has(String(row.state))) {
      return sendError(res, 422, 'invalid_transition', `Cannot reschedule a terminal appointment (state: ${String(row.state)})`);
    }

    const body = req.body ?? {};
    const professionalUserId = body.professional_user_id != null
      ? Number(body.professional_user_id)
      : Number(row.professional_user_id);
    const serviceId = body.service_id != null
      ? Number(body.service_id)
      : Number(row.service_id);
    const resourceId = body.resource_id != null
      ? Number(body.resource_id)
      : (row.resource_id != null ? Number(row.resource_id) : undefined);

    // Parse date + start from the request body, or fall back to the stored starts_at derived
    // in SQL (mirrors scheduling — no locale-string round-trip).
    let date: string;
    let start: string;
    if (body.date && body.start) {
      date = String(body.date);
      start = String(body.start);
    } else {
      const wc = await getAppointmentWallClock(pool, id, BUSINESS_TZ);
      if (!wc) return sendError(res, 404, 'not_found', 'Appointment not found');
      date = wc.date;
      start = wc.start;
    }

    const durationMinutes = body.duration_minutes != null
      ? Number(body.duration_minutes)
      : Number(row.duration_minutes);

    // Same pipeline as create: format checks, business-scoped service/resource/client (client
    // comes from the row, never the body), effective price/duration. Route is staff-only by the
    // authz above, so the requested duration may resolve as a sobreturno length.
    const resolved = await resolveAndLoadService(
      pool,
      businessId,
      {
        professional_user_id: professionalUserId,
        service_id: serviceId,
        resource_id: resourceId,
        client_user_id: Number(row.client_user_id),
        date,
        start,
        duration_minutes: durationMinutes,
      },
      true,
      'Invalid reschedule input',
    );
    if (!resolved.ok) {
      return sendError(res, resolved.status, resolved.code, resolved.message, { fields: resolved.fields, fieldDetails: resolved.fieldDetails });
    }
    const { effective_price, effective_duration_minutes, startsAt } = resolved;

    const override = req.body?.override === true;

    const outcome = await saveWithConflictRecheck(
      pool,
      { businessId, professionalUserId, resourceId, date, start, durationMinutes: effective_duration_minutes, serviceId, excludeAppointmentId: id },
      override,
      async (tx, forced) => {
        const appt = await rescheduleAppointment(tx, id, {
          professionalUserId,
          serviceId,
          resourceId: resourceId ?? null,
          startsAt,
          durationMinutes: effective_duration_minutes,
          price: effective_price,
          overrideConflict: forced,
          overrideActorId: forced ? user.id : null,
          name: body.name ?? null,
          description: body.description ?? null,
        });
        if (!appt) throw httpError(404, 'not_found', 'Appointment not found');
        await auditInTx(tx, user, 'appointment_rescheduled', 'success', id);
        if (forced) await auditConflictOverrideInTx(tx, user, id, 'reschedule');
        return appt;
      },
    );

    if (outcome.kind === 'verdict') return sendData(res, outcome.verdict);
    return sendData(res, outcome.result);
  }));

  app.post(APPOINTMENT_PATTERNS.transition, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid appointment id');
    }

    const to = typeof req.body?.to === 'string' ? req.body.to : '';
    if (!to) {
      return sendError(res, 422, 'invalid_request', 'Field "to" is required');
    }

    const row = await loadAppointment(pool, id, businessId);
    if (!row) return sendError(res, 404, 'not_found', 'Appointment not found');

    const currentState = String(row.state);

    // DB trigger is the backstop.
    const check = assertValidTransition(currentState, to);
    if (!check.ok) {
      return sendError(res, 422, 'invalid_transition', check.message);
    }

    if (user.role === 'Client') {
      if (Number(row.client_user_id) !== user.id) {
        return sendError(res, 403, 'forbidden', 'Clients may only act on their own appointments');
      }
      if (to !== 'canceled') {
        return sendError(res, 403, 'forbidden', 'Clients may only cancel appointments');
      }
      // Cutoff applies to scheduled; requested can be withdrawn anytime.
      if (currentState === 'scheduled') {
        const cutoffHours = (await getCancellationCutoffHours(pool, user.id)) ?? DEFAULT_CANCELLATION_CUTOFF_HOURS;
        if (!canCancelAppointment('scheduled', String(row.starts_at), cutoffHours, Date.now())) {
          return sendError(
            res, 422, 'outside_cutoff',
            `Cancellation is only allowed at least ${cutoffHours} hour(s) before the appointment`,
          );
        }
      }
    } else {
      const authz = await assertAppointmentActionAllowed(pool, user, Number(row.professional_user_id));
      if (!authz.ok) {
        await guards.audit(req, 'appointment_action_denied', 'denied', { reason: authz.code, entity_id: id });
        return sendError(res, authz.status, authz.code, authz.message);
      }
    }

    if (to === 'completed') {
      if (!canCompleteAppointment(currentState, String(row.starts_at), Date.now())) {
        return sendError(
          res, 422, 'too_early',
          `Cannot mark '${to}' before the appointment's start time`,
        );
      }
    }
    if (to === 'no_show') {
      const cutoffHours = (await getCancellationCutoffHours(pool, user.id)) ?? DEFAULT_CANCELLATION_CUTOFF_HOURS;
      if (!canMarkNoShow(currentState, String(row.starts_at), cutoffHours, Date.now())) {
        return sendError(
          res, 422, 'too_early',
          `Cannot mark 'no_show' more than ${cutoffHours} hour(s) before the appointment`,
        );
      }
    }

    const appt = await withTransaction(pool, async (tx) => {
      const updated = await transitionAppointmentState(tx, id, to);
      if (!updated) throw httpError(404, 'not_found', 'Appointment not found');

      await auditInTx(tx, user, `appointment_${to}`, 'success', id);

      // Marking a session attended (completed) bills it: post the session charge once. A no_show
      // never charges, and the guard keeps it idempotent if a charge was already posted.
      if (to === 'completed' && row.price != null && row.client_user_id != null) {
        const chargeId = await insertSessionChargeIfAbsent(tx, {
          clientUserId: row.client_user_id,
          appointmentId: id,
          amountArs: row.price,
          actorUserId: user.id,
        });
        if (chargeId) {
          await auditInTx(tx, user, 'ledger_charge_created', 'success', Number(chargeId), 'ledger_entries');
        }
      }

      return updated;
    });

    if (user.role === 'Client') {
      return sendData(res, stripStaffFields(appt));
    }
    return sendData(res, appt);
  }));

  // Acknowledge (or re-flag) a turno that overlaps time-off. Staff-only; flips the stored bit the
  // in_conflict predicate reads, so an ignored turno leaves the conflict list and the calendar ring.
  app.post(APPOINTMENT_PATTERNS.ignoreConflict, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;
    if (user.role === 'Client') {
      return sendError(res, 403, 'forbidden', 'Clients may not manage conflicts');
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid appointment id');
    }

    const row = await loadAppointment(pool, id, businessId);
    if (!row) return sendError(res, 404, 'not_found', 'Appointment not found');

    const authz = await assertAppointmentActionAllowed(pool, user, Number(row.professional_user_id));
    if (!authz.ok) {
      await guards.audit(req, 'appointment_action_denied', 'denied', { reason: authz.code, entity_id: id });
      return sendError(res, authz.status, authz.code, authz.message);
    }

    // Default to ignoring; an explicit `{ ignored: false }` re-flags it.
    const ignored = req.body?.ignored !== false;

    const appt = await withTransaction(pool, async (tx) => {
      const updated = await setAppointmentConflictIgnored(tx, id, ignored);
      if (!updated) throw httpError(404, 'not_found', 'Appointment not found');
      await auditInTx(tx, user, ignored ? 'appointment_conflict_ignored' : 'appointment_conflict_reflagged', 'success', id);
      return updated;
    });

    return sendData(res, appt);
  }));

  app.patch(APPOINTMENT_PATTERNS.detail, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid appointment id');
    }

    const row = await loadAppointment(pool, id, businessId);
    if (!row) return sendError(res, 404, 'not_found', 'Appointment not found');

    if (user.role === 'Client') {
      return sendError(res, 403, 'forbidden', 'Clients may not edit appointments');
    }

    const authz = await assertAppointmentActionAllowed(pool, user, Number(row.professional_user_id));
    if (!authz.ok) {
      await guards.audit(req, 'appointment_action_denied', 'denied', { reason: authz.code, entity_id: id });
      return sendError(res, authz.status, authz.code, authz.message);
    }

    const body = req.body ?? {};
    const isTerminal = TERMINAL_STATES.has(String(row.state));

    if (isTerminal && (body.name !== undefined || body.description !== undefined)) {
      return sendError(
        res, 422, 'terminal_freeze',
        'Only staff_note may be updated on a terminal appointment',
      );
    }

    // staff_note is staff-only; clients are already blocked above.
    const staffNote =
      body.staff_note !== undefined ? String(body.staff_note) : undefined;
    const name =
      !isTerminal && body.name !== undefined ? String(body.name) : undefined;
    const description =
      !isTerminal && body.description !== undefined ? String(body.description) : undefined;

    if (name === undefined && description === undefined && staffNote === undefined) {
      return sendError(res, 422, 'invalid_request', 'No editable fields provided');
    }

    // Wrap UPDATE + audit in a transaction so a failed audit never leaves a committed edit with
    // no audit trail — matches the durability invariant of every other appointment mutation.
    const appt = await withTransaction(pool, async (tx) => {
      const updated = await patchAppointmentFields(tx, id, { name, description, staffNote });
      if (!updated) throw httpError(404, 'not_found', 'Appointment not found');
      await auditInTx(tx, user, 'appointment_patched', 'success', id, 'appointments', {
        fields: Object.keys(body).filter((k) => ['name', 'description', 'staff_note'].includes(k)),
      });
      return updated;
    });

    return sendData(res, appt);
  }));

  // Backs the "clients with a prior relationship" list without shipping the whole appointment
  // history to the browser. Registered before /:id so the literal path wins.
  app.get(APPOINTMENT_PATTERNS.relatedClients, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;
    if (user.role === 'Client') {
      return sendError(res, 403, 'forbidden', 'Staff access required');
    }

    const relatedIds = await listRelatedClientIds(pool, {
      businessId,
      professionalUserId: user.role === 'Professional' ? user.id : undefined,
      granteeUserId: user.role === 'Receptionist' ? user.id : undefined,
    });

    return sendData(res, { client_user_ids: relatedIds } satisfies RelatedClientIdsResult);
  }));

  app.get(APPOINTMENT_PATTERNS.detail, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    // Clients use /api/appointments (filtered list) + /api/availability.
    if (user.role === 'Client') {
      return sendError(res, 403, 'forbidden', 'Clients may not access the appointment detail view');
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid appointment id');
    }

    const row = await loadAppointment(pool, id, businessId);
    if (!row) return sendError(res, 404, 'not_found', 'Appointment not found');

    const authz = await assertAppointmentActionAllowed(pool, user, Number(row.professional_user_id));
    if (!authz.ok) {
      return sendError(res, authz.status, authz.code, authz.message);
    }

    return sendData(res, row);
  }));

  app.get(APPOINTMENT_PATTERNS.list, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const { limit, page, offset } = parsePagination(req.query);

    let roleScope: AppointmentRoleScope;
    if (user.role === 'Client') roleScope = { kind: 'client', userId: user.id };
    else if (user.role === 'Professional') roleScope = { kind: 'professional', userId: user.id };
    else if (user.role === 'Receptionist') roleScope = { kind: 'receptionist', granteeUserId: user.id };
    else roleScope = { kind: 'all' };

    let dateFrom: string | undefined;
    if (req.query.date_from) {
      if (!DATE_OR_ISO_RE.test(String(req.query.date_from))) {
        return sendError(res, 422, 'invalid_request', 'date_from must be a date (YYYY-MM-DD) or ISO timestamp');
      }
      dateFrom = String(req.query.date_from);
    }

    let dateTo: string | undefined;
    if (req.query.date_to) {
      if (!DATE_OR_ISO_RE.test(String(req.query.date_to))) {
        return sendError(res, 422, 'invalid_request', 'date_to must be a date (YYYY-MM-DD) or ISO timestamp');
      }
      dateTo = String(req.query.date_to);
    }

    const professionalUserId = req.query.professional_user_id
      ? Number(req.query.professional_user_id)
      : undefined;
    const resourceId = req.query.resource_id ? Number(req.query.resource_id) : undefined;

    let clientUserId: number | undefined;
    if (req.query.client_user_id && user.role !== 'Client') {
      // Staff narrowing to one client's turnos. A Client is already pinned to their own via
      // roleScope, so this param is meaningless (and must not widen their scope) for that role.
      const cid = Number(req.query.client_user_id);
      if (!Number.isInteger(cid) || cid <= 0) {
        return sendError(res, 422, 'invalid_request', 'client_user_id must be a positive integer');
      }
      clientUserId = cid;
    }

    let state: string | undefined;
    if (req.query.state) {
      // Requests span the whole future, so the Solicitudes screen filters by state rather than
      // paging through every earlier appointment.
      if (!APPOINTMENT_STATE_VALUES.has(String(req.query.state))) {
        return sendError(res, 422, 'invalid_request', 'Unknown appointment state');
      }
      state = String(req.query.state);
    }

    const conflicting = String(req.query.conflicting) === 'true';

    // Un-materialized recurring occurrences only expand over a bounded window — every current
    // caller that wants 'scheduled' turnos already supplies both bounds (a date-unbounded request
    // filters to state='requested', which a virtual can never match anyway). Date-range mode unions
    // real rows with virtuals and paginates the combined set in memory (the window bounds the row
    // count), so the real-row fetch itself must be unpaginated in that mode.
    const isDateRange = dateFrom != null && dateTo != null;

    // A real row can be in conflict because a virtual occurrence overlaps it — invisible to the SQL
    // predicate, which only sees stored rows. So in date-range mode fetch every real row and apply
    // the conflicting filter in JS after reconciliation; otherwise SQL would pre-drop rows only a
    // virtual would flag. Non-date-range mode has no virtuals, so the SQL filter still applies.
    const { rows, total: realTotal } = await listAppointments(pool, {
      businessId,
      roleScope,
      tz: BUSINESS_TZ,
      dateFrom,
      dateTo,
      professionalUserId,
      resourceId,
      clientUserId,
      state,
      conflicting: conflicting && !isDateRange,
      limit,
      offset,
      unpaginated: isDateRange,
    });

    let virtuals: Awaited<ReturnType<typeof listVirtualOccurrences>> = [];
    if (dateFrom != null && dateTo != null) {
      virtuals = await listVirtualOccurrences(pool, {
        businessId,
        roleScope,
        windowStart: toBusinessDate(dateFrom),
        windowEnd: toBusinessDate(dateTo),
        professionalUserId,
        resourceId,
        clientUserId,
        state,
      });
      flagRealConflictsWithVirtuals(rows, virtuals, Date.now());
    }

    const startsAtMs = (r: ListAppointment): number => (r.id === null ? new Date(r.starts_at).getTime() : r.starts_at.getTime());
    let combined: ListAppointment[] = [...rows, ...virtuals].sort((a, b) => startsAtMs(a) - startsAtMs(b));

    // Reconciliation may flag a real row (or a virtual) the SQL pre-filter never saw, so the
    // conflicting narrowing runs here over the combined set in date-range mode.
    if (isDateRange && conflicting) combined = combined.filter((r) => r.in_conflict === true);

    // Non-date-range mode already has the correct SQL-paginated page and total (virtuals are always
    // empty there); date-range mode paginates the combined, sorted set here instead.
    const pageRows = isDateRange ? combined.slice(offset, offset + limit) : combined;
    const total = isDateRange ? combined.length : realTotal;

    const data = user.role === 'Client'
      ? pageRows.map((r) => (r.id === null ? r : stripStaffFields(r)))
      : pageRows;

    return sendList(res, data, { page, limit, total });
  }));

  // Create a recurrence rule + a lock-free preview of the next SERIES_PREVIEW_DAYS window. Same
  // authz/price-freeze pipeline as /schedule; occurrences themselves are never stored (computed on
  // demand) until touched via /materialize.
  app.post(APPOINTMENT_PATTERNS.seriesCreate, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const body = req.body ?? {};
    const professionalUserId = Number(body.professional_user_id);

    const authz = await assertAppointmentActionAllowed(pool, user, professionalUserId);
    if (!authz.ok) {
      await guards.audit(req, 'appointment_action_denied', 'denied', {
        reason: authz.code,
        professional_user_id: professionalUserId,
      });
      return sendError(res, authz.status, authz.code, authz.message);
    }

    const resolved = await resolveAndLoadService(
      pool,
      businessId,
      { ...body, date: body.start_date, start: body.start_time },
      true,
      'Invalid series input',
    );
    if (!resolved.ok) {
      return sendError(res, resolved.status, resolved.code, resolved.message, { fields: resolved.fields, fieldDetails: resolved.fieldDetails });
    }

    // client_user_id is NOT NULL on appointment_series — checked here, mirroring how /schedule
    // checks it just before the write.
    if (!isPositiveInteger(resolved.clientUserId)) {
      return sendError(res, 422, 'invalid_request', 'Invalid series input', { fields: { client_user_id: 'required' } });
    }

    const rawRule: RecurrenceRuleFields = {
      frequency: String(body.frequency ?? ''),
      interval: Number(body.interval),
      weekday: body.weekday != null ? String(body.weekday) : null,
      week_of_month: body.week_of_month != null ? Number(body.week_of_month) : null,
      day_of_month: body.day_of_month != null ? Number(body.day_of_month) : null,
      start_time: resolved.start,
      start_date: resolved.date,
      end_kind: String(body.end_kind ?? ''),
      end_count: body.end_count != null ? Number(body.end_count) : null,
      end_date: body.end_date != null ? String(body.end_date) : null,
    };
    const parsedRule = parseRecurrenceRule(rawRule);
    if ('fields' in parsedRule) return sendError(res, 422, 'invalid_request', 'Invalid recurrence rule', { fields: parsedRule.fields });
    const rule = parsedRule.data;

    const series = await withTransaction(pool, async (tx) => {
      const inserted = await insertSeries(tx, {
        client_user_id: String(resolved.clientUserId),
        professional_user_id: String(resolved.professionalUserId),
        service_id: String(resolved.serviceId),
        resource_id: resolved.resourceId != null ? String(resolved.resourceId) : null,
        frequency: rule.frequency,
        interval: rule.interval,
        weekday: rule.weekday,
        week_of_month: rule.week_of_month,
        day_of_month: rule.day_of_month,
        start_time: rule.start_time,
        duration_minutes: resolved.effective_duration_minutes,
        price_ars: resolved.effective_price,
        start_date: rule.start_date,
        end_kind: rule.end_kind,
        end_count: rule.end_count,
        end_date: rule.end_date,
        created_by_user_id: String(user.id),
      });
      if (!inserted) throw new Error('insertSeries: insert returned no row');
      await auditInTx(tx, user, 'appointment_series_created', 'success', Number(inserted.id), 'appointment_series');
      return inserted;
    });

    // Preview: no lock — a mere read must not serialize against real bookings. Window is bounded
    // to SERIES_PREVIEW_DAYS so an open-ended series never triggers an unbounded scan.
    const today = new Date().toISOString().slice(0, 10);
    const windowStart = series.start_date > today ? series.start_date : today;
    const windowEnd = addDaysISO(windowStart, SERIES_PREVIEW_DAYS);
    const occurrenceDates = expandSeries(seriesRuleFromRow(series), windowStart, windowEnd);

    const skipped: { date: string; conflicts: Conflict[] }[] = [];
    for (const date of occurrenceDates) {
      const dryRun = await runConflictDryRun(pool, businessId, {
        professionalUserId: Number(series.professional_user_id),
        resourceId: series.resource_id != null ? Number(series.resource_id) : undefined,
        serviceId: Number(series.service_id),
        date,
        start: series.start_time.slice(0, 5),
        durationMinutes: series.duration_minutes,
        callerIsStaff: true,
      });
      if (dryRun.ok && dryRun.verdict.conflicts.length > 0) {
        skipped.push({ date, conflicts: dryRun.verdict.conflicts });
      }
    }

    return sendData(res, { series, preview: { skipped } } satisfies ScheduleSeriesResult<AppointmentSeriesRow>, 201);
  }));

  // Touch one occurrence into an ordinary appointments row so the existing reschedule/transition
  // endpoints can act on it individually. Idempotent — a second call for the same date returns the
  // same row (see ensureOccurrenceMaterialized).
  app.post(APPOINTMENT_PATTERNS.seriesMaterialize, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid series id');
    }

    const series = await getSeriesById(pool, id, businessId);
    if (!series) return sendError(res, 404, 'not_found', 'Series not found');

    const authz = await assertAppointmentActionAllowed(pool, user, Number(series.professional_user_id));
    if (!authz.ok) {
      await guards.audit(req, 'appointment_action_denied', 'denied', { reason: authz.code, entity_id: id });
      return sendError(res, authz.status, authz.code, authz.message);
    }

    const occurrenceDate = typeof req.body?.occurrence_date === 'string' ? req.body.occurrence_date : '';
    if (!DATE_RE.test(occurrenceDate)) {
      return sendError(res, 422, 'invalid_request', 'occurrence_date must be YYYY-MM-DD', { fields: { occurrence_date: 'required' } });
    }
    if (!canMaterializeOccurrence(series, occurrenceDate)) {
      return sendError(res, 422, 'invalid_request', 'occurrence_date is not part of this series', {
        fields: { occurrence_date: 'not_in_series' },
      });
    }

    const appointment = await withTransaction(pool, async (tx) => {
      const appt = await ensureOccurrenceMaterialized(tx, series, occurrenceDate);
      await auditInTx(tx, user, 'appointment_series_occurrence_materialized', 'success', Number(appt.id));
      return appt;
    });

    return sendData(res, { appointment } satisfies MaterializedOccurrenceResult<AppointmentRow>);
  }));

  // Read one series' current rule — backs the frontend's reschedule-scope weekday decision and the
  // rule editor's prefill, neither of which is carried on the appointment row itself. Mirrors the
  // PUT below: business-scoped via getSeriesById (404s, never leaking cross-tenant existence),
  // staff-only via assertAppointmentActionAllowed.
  app.get(APPOINTMENT_PATTERNS.seriesDetail, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid series id');
    }

    const series = await getSeriesById(pool, id, businessId);
    if (!series) return sendError(res, 404, 'not_found', 'Series not found');

    const authz = await assertAppointmentActionAllowed(pool, user, Number(series.professional_user_id));
    if (!authz.ok) {
      return sendError(res, authz.status, authz.code, authz.message);
    }

    return sendData(res, series);
  }));

  // Whole-series rule edit. Price/duration stay frozen unless the patch touches a field that feeds
  // resolveBooking's precedence chain (service/resource/client/duration) — that's a deliberate
  // re-freeze, never a client-supplied number.
  app.put(APPOINTMENT_PATTERNS.seriesDetail, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid series id');
    }

    const series = await getSeriesById(pool, id, businessId);
    if (!series) return sendError(res, 404, 'not_found', 'Series not found');

    const authz = await assertAppointmentActionAllowed(pool, user, Number(series.professional_user_id));
    if (!authz.ok) {
      await guards.audit(req, 'appointment_action_denied', 'denied', { reason: authz.code, entity_id: id });
      return sendError(res, authz.status, authz.code, authz.message);
    }

    const body = req.body ?? {};

    const rawRule: RecurrenceRuleFields = {
      frequency: body.frequency !== undefined ? String(body.frequency) : series.frequency,
      interval: body.interval !== undefined ? Number(body.interval) : series.interval,
      weekday: body.weekday !== undefined ? (body.weekday != null ? String(body.weekday) : null) : series.weekday,
      week_of_month: body.week_of_month !== undefined
        ? (body.week_of_month != null ? Number(body.week_of_month) : null)
        : series.week_of_month,
      day_of_month: body.day_of_month !== undefined
        ? (body.day_of_month != null ? Number(body.day_of_month) : null)
        : series.day_of_month,
      start_time: body.start_time !== undefined ? String(body.start_time) : series.start_time.slice(0, 5),
      start_date: body.start_date !== undefined ? String(body.start_date) : series.start_date,
      end_kind: body.end_kind !== undefined ? String(body.end_kind) : series.end_kind,
      end_count: body.end_count !== undefined ? (body.end_count != null ? Number(body.end_count) : null) : series.end_count,
      end_date: body.end_date !== undefined ? (body.end_date != null ? String(body.end_date) : null) : series.end_date,
    };
    const parsedRule = parseRecurrenceRule(rawRule);
    if ('fields' in parsedRule) return sendError(res, 422, 'invalid_request', 'Invalid recurrence rule', { fields: parsedRule.fields });
    const rule = parsedRule.data;

    const patch: Partial<InsertSeriesInput> = {
      frequency: rule.frequency,
      interval: rule.interval,
      weekday: rule.weekday,
      week_of_month: rule.week_of_month,
      day_of_month: rule.day_of_month,
      start_time: rule.start_time,
      start_date: rule.start_date,
      end_kind: rule.end_kind,
      end_count: rule.end_count,
      end_date: rule.end_date,
    };

    const PRICE_AFFECTING_KEYS = ['service_id', 'client_user_id', 'resource_id', 'duration_minutes', 'price_ars'];
    if (PRICE_AFFECTING_KEYS.some((k) => body[k] !== undefined)) {
      const resolved = await resolveAndLoadService(
        pool,
        businessId,
        {
          professional_user_id: series.professional_user_id,
          service_id: body.service_id !== undefined ? body.service_id : series.service_id,
          resource_id: body.resource_id !== undefined ? body.resource_id : series.resource_id,
          client_user_id: body.client_user_id !== undefined ? body.client_user_id : series.client_user_id,
          date: rule.start_date,
          start: rule.start_time,
          duration_minutes: body.duration_minutes !== undefined ? body.duration_minutes : series.duration_minutes,
        },
        true,
        'Invalid series input',
      );
      if (!resolved.ok) {
        return sendError(res, resolved.status, resolved.code, resolved.message, { fields: resolved.fields, fieldDetails: resolved.fieldDetails });
      }
      if (!isPositiveInteger(resolved.clientUserId)) {
        return sendError(res, 422, 'invalid_request', 'Invalid series input', { fields: { client_user_id: 'required' } });
      }
      patch.service_id = String(resolved.serviceId);
      patch.resource_id = resolved.resourceId != null ? String(resolved.resourceId) : null;
      patch.client_user_id = String(resolved.clientUserId);
      patch.duration_minutes = resolved.effective_duration_minutes;
      patch.price_ars = resolved.effective_price;
    }

    const updated = await withTransaction(pool, async (tx) => {
      const row = await updateSeriesRule(tx, String(id), patch);
      if (!row) throw new Error('updateSeriesRule: update returned no row');
      await auditInTx(tx, user, 'appointment_series_updated', 'success', id, 'appointment_series');
      return row;
    });

    return sendData(res, { series: updated } satisfies SeriesResult<AppointmentSeriesRow>);
  }));

  // This-and-future split: ends the current rule the day before from_date and opens a new series
  // (old identity/frozen values merged with the patch) starting exactly on from_date.
  app.post(APPOINTMENT_PATTERNS.seriesFuture, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid series id');
    }

    const series = await getSeriesById(pool, id, businessId);
    if (!series) return sendError(res, 404, 'not_found', 'Series not found');

    const authz = await assertAppointmentActionAllowed(pool, user, Number(series.professional_user_id));
    if (!authz.ok) {
      await guards.audit(req, 'appointment_action_denied', 'denied', { reason: authz.code, entity_id: id });
      return sendError(res, authz.status, authz.code, authz.message);
    }

    const body = req.body ?? {};
    const fromDate = typeof body.from_date === 'string' ? body.from_date : '';
    if (!DATE_RE.test(fromDate)) {
      return sendError(res, 422, 'invalid_request', 'from_date must be YYYY-MM-DD', { fields: { from_date: 'required' } });
    }

    const patch = body.patch ?? {};
    const rawRule: RecurrenceRuleFields = {
      frequency: patch.frequency !== undefined ? String(patch.frequency) : series.frequency,
      interval: patch.interval !== undefined ? Number(patch.interval) : series.interval,
      weekday: patch.weekday !== undefined ? (patch.weekday != null ? String(patch.weekday) : null) : series.weekday,
      week_of_month: patch.week_of_month !== undefined
        ? (patch.week_of_month != null ? Number(patch.week_of_month) : null)
        : series.week_of_month,
      day_of_month: patch.day_of_month !== undefined
        ? (patch.day_of_month != null ? Number(patch.day_of_month) : null)
        : series.day_of_month,
      start_time: patch.start_time !== undefined ? String(patch.start_time) : series.start_time.slice(0, 5),
      start_date: fromDate,
      end_kind: patch.end_kind !== undefined ? String(patch.end_kind) : series.end_kind,
      end_count: patch.end_count !== undefined ? (patch.end_count != null ? Number(patch.end_count) : null) : series.end_count,
      end_date: patch.end_date !== undefined ? (patch.end_date != null ? String(patch.end_date) : null) : series.end_date,
    };
    const parsedRule = parseRecurrenceRule(rawRule);
    if ('fields' in parsedRule) return sendError(res, 422, 'invalid_request', 'Invalid recurrence rule', { fields: parsedRule.fields });
    const rule = parsedRule.data;

    const result = await withTransaction(pool, async (tx) => {
      await endSeriesAt(tx, String(id), addDaysISO(fromDate, -1));
      await auditInTx(tx, user, 'appointment_series_ended', 'success', id, 'appointment_series');
      const ended = await getSeriesById(tx, id, businessId);
      if (!ended) throw new Error('seriesFuture: ended series disappeared');

      const created = await insertSeries(tx, {
        client_user_id: series.client_user_id,
        professional_user_id: series.professional_user_id,
        service_id: series.service_id,
        resource_id: series.resource_id,
        frequency: rule.frequency,
        interval: rule.interval,
        weekday: rule.weekday,
        week_of_month: rule.week_of_month,
        day_of_month: rule.day_of_month,
        start_time: rule.start_time,
        duration_minutes: series.duration_minutes,
        price_ars: series.price_ars,
        start_date: rule.start_date,
        end_kind: rule.end_kind,
        end_count: rule.end_count,
        end_date: rule.end_date,
        created_by_user_id: String(user.id),
      });
      if (!created) throw new Error('insertSeries: insert returned no row');
      await auditInTx(tx, user, 'appointment_series_created', 'success', Number(created.id), 'appointment_series');

      return { ended, created } satisfies SplitSeriesResult<AppointmentSeriesRow>;
    });

    return sendData(res, result, 201);
  }));

  // Stop the series from a date (defaulting to its own start_date — the whole series). Ends the
  // rule so no further virtual occurrences generate at/after fromDate, and cancels any
  // already-materialized non-terminal occurrences in the same range.
  app.post(APPOINTMENT_PATTERNS.seriesEnd, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid series id');
    }

    const series = await getSeriesById(pool, id, businessId);
    if (!series) return sendError(res, 404, 'not_found', 'Series not found');

    const authz = await assertAppointmentActionAllowed(pool, user, Number(series.professional_user_id));
    if (!authz.ok) {
      await guards.audit(req, 'appointment_action_denied', 'denied', { reason: authz.code, entity_id: id });
      return sendError(res, authz.status, authz.code, authz.message);
    }

    const body = req.body ?? {};
    let fromDate = series.start_date;
    if (body.from_date !== undefined) {
      if (typeof body.from_date !== 'string' || !DATE_RE.test(body.from_date)) {
        return sendError(res, 422, 'invalid_request', 'from_date must be YYYY-MM-DD', { fields: { from_date: 'invalid' } });
      }
      fromDate = body.from_date;
    }

    const result = await withTransaction(pool, async (tx) => {
      await endSeriesAt(tx, String(id), addDaysISO(fromDate, -1));
      const ended = await getSeriesById(tx, id, businessId);
      if (!ended) throw new Error('seriesEnd: ended series disappeared');
      const canceledRows = await cancelFutureOccurrences(tx, String(id), fromDate);
      const canceled = canceledRows.map((r) => r.id);
      await auditInTx(tx, user, 'appointment_series_ended', 'success', id, 'appointment_series', { canceled });
      return { ended, canceled } satisfies EndSeriesResult<AppointmentSeriesRow>;
    });

    return sendData(res, result);
  }));
}
