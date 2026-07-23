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
  APPOINTMENT_STATES,
  assertValidTransition,
  canCancelAppointment,
  canMarkNoShow,
  canCompleteAppointment,
  DEFAULT_CANCELLATION_CUTOFF_HOURS,
} from '../../../shared/src/ssot/domain';
import { BUSINESS_TZ, toBusinessDate } from '../time';
import { MAX_LIST_WINDOW_DAYS } from '../../../shared/src/ssot/domain/recurrence-expand';
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
  APPOINTMENT_SORT_COLUMNS,
  APPOINTMENT_DEFAULT_SORT,
  type AppointmentRoleScope,
} from '../db/appointments';
import type { ListSort } from '../db/sort';
import type { AppointmentSortField } from '../../../shared/src/ssot/list-sort';
import { resolveAndLoadService, runConflictDryRun, saveWithConflictRecheck } from '../services/booking';
import { insertSessionChargeIfAbsent } from '../db/ledger';
import { getCancellationCutoffHours } from '../db/businesses';
import { listVirtualOccurrences, flagRealConflictsWithVirtuals } from '../services/series-listing';
import { mountAppointmentSeriesRoutes } from './appointment-series';
import {
  isPositiveInteger,
  requireIdParam,
  requireRequestFields,
  type RequestSpec,
} from './request-guards';
import type { AppointmentRow, ListAppointment } from '../../../shared/src/ssot/query-types';
import type { RelatedClientIdsResult } from '../../../shared/src/ssot/contracts/appointments';
import { parsePagination, parseListSort } from './pagination';
import { APPOINTMENT_PATTERNS } from '../../../shared/src/ssot/api-paths';

// A date-range list unions stored rows with un-materialized recurring occurrences, so the order the
// SQL produced has to be reproduced over the union in memory. Same column set, same direction.
function appointmentSortValue(r: ListAppointment, column: AppointmentSortField): string | number {
  if (column === 'starts_at') return r.id === null ? new Date(r.starts_at).getTime() : r.starts_at.getTime();
  if (column === 'duration_minutes') return r.duration_minutes;
  if (column === 'price') return Number(r.price);
  return r.state;
}

// Unique per entry, so a tie on the sort column can't make paging repeat one turno and drop
// another. A virtual occurrence has no row id yet, so its series and date stand in.
function appointmentTiebreak(r: ListAppointment): string {
  return r.id === null ? `v:${r.series_id}:${r.occurrence_date}` : `r:${String(r.id).padStart(20, '0')}`;
}

function compareAppointments(a: ListAppointment, b: ListAppointment, sort: ListSort<AppointmentSortField>): number {
  const left = appointmentSortValue(a, sort.column);
  const right = appointmentSortValue(b, sort.column);
  let cmp = 0;
  if (typeof left === 'number' && typeof right === 'number') cmp = left - right;
  else cmp = String(left).localeCompare(String(right));
  if (cmp === 0) cmp = appointmentTiebreak(a).localeCompare(appointmentTiebreak(b));
  return sort.dir === 'asc' ? cmp : -cmp;
}

function stripStaffFields(row: AppointmentRow): Omit<AppointmentRow, 'staff_note' | 'override_actor_id'> {
  const { staff_note: _staffNote, override_actor_id: _overrideActorId, ...safe } = row;
  return safe;
}

const APPOINTMENT_STATE_LIST = APPOINTMENT_STATES.map((s) => s.value);

const TRANSITION_BODY = {
  to: { kind: 'enum', values: APPOINTMENT_STATE_LIST, required: true },
} as const satisfies RequestSpec;

const IGNORE_CONFLICT_BODY = {
  ignored: { kind: 'boolean' },
} as const satisfies RequestSpec;

const PATCH_BODY = {
  name: { kind: 'text' },
  description: { kind: 'text' },
  staff_note: { kind: 'text' },
} as const satisfies RequestSpec;

const LIST_QUERY = {
  date_from: { kind: 'dateOrIso' },
  date_to: { kind: 'dateOrIso' },
  professional_user_id: { kind: 'id' },
  resource_id: { kind: 'id' },
  client_user_id: { kind: 'id' },
  state: { kind: 'enum', values: APPOINTMENT_STATE_LIST },
  conflicting: { kind: 'boolean' },
} as const satisfies RequestSpec;

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

    const id = requireIdParam(res, req.params.id, 'appointment');
    if (id == null) return;

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

    const id = requireIdParam(res, req.params.id, 'appointment');
    if (id == null) return;

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

    const id = requireIdParam(res, req.params.id, 'appointment');
    if (id == null) return;

    const parsed = requireRequestFields(res, TRANSITION_BODY, req.body, 'Invalid transition request');
    if (!parsed) return;
    const to = parsed.to;

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
            { detail: { key: 'cancelCutoff', params: { hours: cutoffHours } } },
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
          { detail: { key: 'completeTooEarly' } },
        );
      }
    }
    if (to === 'no_show') {
      const cutoffHours = (await getCancellationCutoffHours(pool, user.id)) ?? DEFAULT_CANCELLATION_CUTOFF_HOURS;
      if (!canMarkNoShow(currentState, String(row.starts_at), cutoffHours, Date.now())) {
        return sendError(
          res, 422, 'too_early',
          `Cannot mark 'no_show' more than ${cutoffHours} hour(s) before the appointment`,
          { detail: { key: 'noShowTooEarly', params: { hours: cutoffHours } } },
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

    const id = requireIdParam(res, req.params.id, 'appointment');
    if (id == null) return;

    const row = await loadAppointment(pool, id, businessId);
    if (!row) return sendError(res, 404, 'not_found', 'Appointment not found');

    const authz = await assertAppointmentActionAllowed(pool, user, Number(row.professional_user_id));
    if (!authz.ok) {
      await guards.audit(req, 'appointment_action_denied', 'denied', { reason: authz.code, entity_id: id });
      return sendError(res, authz.status, authz.code, authz.message);
    }

    // Default to ignoring; an explicit `{ ignored: false }` re-flags it.
    const parsed = requireRequestFields(res, IGNORE_CONFLICT_BODY, req.body, 'Invalid conflict-ignore request');
    if (!parsed) return;
    const ignored = parsed.ignored !== false;

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

    const id = requireIdParam(res, req.params.id, 'appointment');
    if (id == null) return;

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

    const parsed = requireRequestFields(res, PATCH_BODY, req.body, 'Invalid appointment patch');
    if (!parsed) return;

    const isTerminal = TERMINAL_STATES.has(String(row.state));
    if (isTerminal && (parsed.name !== undefined || parsed.description !== undefined)) {
      return sendError(
        res, 422, 'terminal_freeze',
        'Only staff_note may be updated on a terminal appointment',
      );
    }

    // staff_note is staff-only; clients are already blocked above.
    const { staff_note: staffNote } = parsed;
    const name = isTerminal ? undefined : parsed.name;
    const description = isTerminal ? undefined : parsed.description;

    if (name === undefined && description === undefined && staffNote === undefined) {
      return sendError(res, 422, 'invalid_request', 'No editable fields provided');
    }

    // Wrap UPDATE + audit in a transaction so a failed audit never leaves a committed edit with
    // no audit trail — matches the durability invariant of every other appointment mutation.
    const appt = await withTransaction(pool, async (tx) => {
      const updated = await patchAppointmentFields(tx, id, { name, description, staffNote });
      if (!updated) throw httpError(404, 'not_found', 'Appointment not found');
      await auditInTx(tx, user, 'appointment_patched', 'success', id, 'appointments', {
        fields: Object.entries({ name, description, staff_note: staffNote })
          .filter(([, value]) => value !== undefined)
          .map(([field]) => field),
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

    const id = requireIdParam(res, req.params.id, 'appointment');
    if (id == null) return;

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
    const sort = parseListSort(req.query, APPOINTMENT_SORT_COLUMNS, APPOINTMENT_DEFAULT_SORT);

    const query = requireRequestFields(res, LIST_QUERY, req.query, 'Invalid appointment list query');
    if (!query) return;

    let roleScope: AppointmentRoleScope;
    if (user.role === 'Client') roleScope = { kind: 'client', userId: user.id };
    else if (user.role === 'Professional') roleScope = { kind: 'professional', userId: user.id };
    else if (user.role === 'Receptionist') roleScope = { kind: 'receptionist', granteeUserId: user.id };
    else roleScope = { kind: 'all' };

    const { date_from: dateFrom, date_to: dateTo, professional_user_id: professionalUserId, resource_id: resourceId } = query;

    // Staff narrowing to one client's turnos. A Client is already pinned to their own via
    // roleScope, so this param is meaningless (and must not widen their scope) for that role.
    const clientUserId = user.role === 'Client' ? undefined : query.client_user_id;

    // Requests span the whole future, so the Solicitudes screen filters by state rather than
    // paging through every earlier appointment.
    const state = query.state;

    const conflicting = query.conflicting === true;

    // Date-range mode fetches real rows unpaginated and expands every series across the window, so
    // the span is what bounds the work — reject a window no screen legitimately needs before doing
    // either. A single day counts as a 0-day span, so the bound is inclusive.
    if (dateFrom != null && dateTo != null) {
      const spanDays = Math.round(
        (Date.parse(toBusinessDate(dateTo)) - Date.parse(toBusinessDate(dateFrom))) / 86_400_000,
      );
      if (spanDays > MAX_LIST_WINDOW_DAYS) {
        return sendError(res, 422, 'invalid_request',
          `Date range too wide (max ${MAX_LIST_WINDOW_DAYS} days)`);
      }
    }

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
      sort,
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

    let combined: ListAppointment[] = [...rows, ...virtuals].sort((a, b) => compareAppointments(a, b, sort));

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

  mountAppointmentSeriesRoutes(app, pool, guards);
}
