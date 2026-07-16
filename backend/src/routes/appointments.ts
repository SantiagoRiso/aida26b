import express from 'express';
import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import { sendData, sendError, sendList } from '../status_messages';
import { guardRoute } from '../helpers';
import { type AuthedRequest } from '../session';
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
} from '../../../shared/src/ssot/domain';
import { BUSINESS_TZ, DATE_OR_ISO_RE } from '../time';
import { httpError } from '../errors';
import { assertAppointmentActionAllowed, auditInTx } from './appointment-authz';
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
import type { AppointmentRow } from '../../../shared/src/ssot/query-types';
import { parsePagination } from './pagination';
import { APPOINTMENT_PATTERNS } from '../../../shared/src/ssot/api-paths';

const STAFF_ONLY_FIELDS = ['staff_note', 'override_actor_id'] as const;

function stripStaffFields(row: AppointmentRow): Omit<AppointmentRow, (typeof STAFF_ONLY_FIELDS)[number]> {
  const r: Partial<AppointmentRow> = { ...row };
  for (const f of STAFF_ONLY_FIELDS) delete r[f];
  return r as Omit<AppointmentRow, (typeof STAFF_ONLY_FIELDS)[number]>;
}

export function mountAppointmentRoutes(
  app: express.Application,
  pool: Pool,
  guards: { auth: RequestHandler; passwordReady: RequestHandler; audit: AuditWriter },
) {
  app.post(APPOINTMENT_PATTERNS.request, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;

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
      return sendError(res, resolved.status, resolved.code, resolved.message, resolved.fields);
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
      await auditInTx(tx, user, 'appointment_requested', 'success', Number(inserted!.id));
      return inserted!;
    });

    return sendData(res, stripStaffFields(appt), 201);
  }));

  app.post(APPOINTMENT_PATTERNS.schedule, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;

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
      return sendError(res, resolved.status, resolved.code, resolved.message, resolved.fields);
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
        if (!Number.isInteger(clientUserId) || (clientUserId as number) <= 0) {
          throw httpError(422, 'invalid_request', 'Invalid appointment input', { client_user_id: 'required' });
        }
        // `forced` marks a sobreturno — an override that bypassed a real conflict; a redundant
        // override flag on a clean booking must not mark the row.
        const appt = await insertScheduledAppointment(tx, {
          clientUserId: clientUserId as number,
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
        await auditInTx(tx, user, 'appointment_scheduled', 'success', Number(appt!.id));
        return appt!;
      },
    );

    if (outcome.kind === 'verdict') return sendData(res, outcome.verdict);
    return sendData(res, outcome.result, 201);
  }));

  app.post(APPOINTMENT_PATTERNS.approve, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;
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
        await auditInTx(tx, user, 'appointment_approved', 'success', id);
        return appt!;
      },
    );

    if (outcome.kind === 'verdict') return sendData(res, outcome.verdict);
    return sendData(res, outcome.result);
  }));

  app.post(APPOINTMENT_PATTERNS.reschedule, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;
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
      return sendError(res, resolved.status, resolved.code, resolved.message, resolved.fields);
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
        await auditInTx(tx, user, 'appointment_rescheduled', 'success', id);
        return appt!;
      },
    );

    if (outcome.kind === 'verdict') return sendData(res, outcome.verdict);
    return sendData(res, outcome.result);
  }));

  app.post(APPOINTMENT_PATTERNS.transition, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;
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

      return updated!;
    });

    if (user.role === 'Client') {
      return sendData(res, stripStaffFields(appt));
    }
    return sendData(res, appt);
  }));

  // Acknowledge (or re-flag) a turno that overlaps time-off. Staff-only; flips the stored bit the
  // in_conflict predicate reads, so an ignored turno leaves the conflict list and the calendar ring.
  app.post(APPOINTMENT_PATTERNS.ignoreConflict, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;
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
      await auditInTx(tx, user, ignored ? 'appointment_conflict_ignored' : 'appointment_conflict_reflagged', 'success', id);
      return updated!;
    });

    return sendData(res, appt);
  }));

  app.patch(APPOINTMENT_PATTERNS.detail, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;
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
      await auditInTx(tx, user, 'appointment_patched', 'success', id, 'appointments', {
        fields: Object.keys(body).filter((k) => ['name', 'description', 'staff_note'].includes(k)),
      });
      return updated!;
    });

    return sendData(res, appt);
  }));

  // Backs the "clients with a prior relationship" list without shipping the whole appointment
  // history to the browser. Registered before /:id so the literal path wins.
  app.get(APPOINTMENT_PATTERNS.relatedClients, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;
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

    return sendData(res, { client_user_ids: relatedIds });
  }));

  app.get(APPOINTMENT_PATTERNS.detail, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;
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
    const user = (req as AuthedRequest).user!;
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

    const { rows, total } = await listAppointments(pool, {
      businessId,
      roleScope,
      tz: BUSINESS_TZ,
      dateFrom,
      dateTo,
      professionalUserId,
      resourceId,
      clientUserId,
      state,
      conflicting,
      limit,
      offset,
    });

    const data = user.role === 'Client' ? rows.map(stripStaffFields) : rows;

    return sendList(res, data, { page, limit, total });
  }));
}
