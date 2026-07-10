import express from 'express';
import type { Request, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { sendData, sendError, sendList } from '../status_messages';
import { guardRoute } from '../helpers';
import type { AuthUser } from '../auth';
import {
  resolveBooking,
  TERMINAL_STATES,
  APPOINTMENT_STATE_VALUES,
  assertValidTransition,
  canCancelAppointment,
  DEFAULT_CANCELLATION_CUTOFF_HOURS,
} from '../../../shared/src/ssot/domain';
import { BUSINESS_TZ, HHMM_RE, DATE_RE, addMinutes, crossesMidnight, buildStartsAt } from '../time';
import { httpError } from '../db/errors';
import { assertAppointmentActionAllowed, auditInTx } from './appointment-authz';
import { withTransaction } from '../db/core';
import { getServiceDefaultPrice, getClientOverridePrice } from '../db/catalog';
import {
  loadAppointment,
  getAppointmentWallClock,
  insertRequestedAppointment,
  insertScheduledAppointment,
  approveAppointment,
  rescheduleAppointment,
  transitionAppointmentState,
  patchAppointmentFields,
  listAppointments,
  listRelatedClientIds,
  type AppointmentRoleScope,
} from '../db/appointments';
import { resolveAndLoadService, saveWithConflictRecheck } from '../services/booking';
import { insertSessionChargeIfAbsent } from '../db/ledger';
import { getCancellationCutoffHours } from '../db/businesses';
import type { ColumnValue } from '../../../shared/src/types/types';
import type { AppointmentRow } from '../../../shared/src/ssot/query-types';

type AuthedRequest = Request & { user?: AuthUser };

type AuditFn = (
  req: Request,
  eventType: string,
  outcome: string,
  details?: Record<string, ColumnValue>,
) => Promise<void>;

const DATE_OR_ISO_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?([+-]\d{2}:?\d{2})?)?$/;

const STAFF_ONLY_FIELDS = ['staff_note', 'override_actor_id'] as const;

function stripStaffFields(row: AppointmentRow): Omit<AppointmentRow, (typeof STAFF_ONLY_FIELDS)[number]> {
  const r: Partial<AppointmentRow> = { ...row };
  for (const f of STAFF_ONLY_FIELDS) delete r[f];
  return r as Omit<AppointmentRow, (typeof STAFF_ONLY_FIELDS)[number]>;
}

export function mountAppointmentRoutes(
  app: express.Application,
  pool: Pool,
  guards: { auth: RequestHandler; passwordReady: RequestHandler; audit: AuditFn },
) {
  app.post('/api/appointments/request', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;

    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'Business context required');
    }
    const businessId = user.business_id;
    if (user.role !== 'Client') {
      return sendError(res, 403, 'forbidden', 'Only clients may use the request endpoint');
    }

    const body = req.body ?? {};
    // Client is always the caller; ignore any body-supplied client_user_id.
    body.client_user_id = user.id;

    const resolved = await resolveAndLoadService(pool, businessId, body);
    if (!resolved.ok) {
      return sendError(res, resolved.status, resolved.code, resolved.message, resolved.fields);
    }

    const {
      professionalUserId,
      serviceId,
      date,
      start,
      durationMinutes: resolvedDuration,
      effective_duration_minutes,
      effective_price,
      name,
      description,
      startsAt,
    } = resolved;

    // Dry-run conflict check — read-only, no advisory lock needed for a mere read.
    const { loadConflictInputs } = await import('../services/scheduling');
    const inputs = await loadConflictInputs(pool, businessId, {
      professionalUserId,
      date,
    });
    if ('error' in inputs) {
      return sendError(res, inputs.error.status, inputs.error.code, inputs.error.message);
    }

    const { evaluateConflicts } = await import('../../../shared/src/ssot/domain');
    const end = addMinutes(start, resolvedDuration);
    const verdict = evaluateConflicts({
      proposed: { start, end, date },
      callerIsStaff: false,
      professional: { id: inputs.professional.id, name: inputs.professional.name, slots: inputs.professional.gridSlots, booked: inputs.professional.booked },
    });

    if (verdict.requires_override) {
      // Clients can never override.
      return sendData(res, verdict);
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

  app.post('/api/appointments/schedule', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;

    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'Business context required');
    }
    const businessId = user.business_id;

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

    const resolved = await resolveAndLoadService(pool, businessId, body);
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
      { businessId, professionalUserId, resourceId, date, start, durationMinutes: effective_duration_minutes },
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

  app.post('/api/appointments/:id/approve', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;
    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'Business context required');
    }
    const businessId = user.business_id;

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

  app.post('/api/appointments/:id/reschedule', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;
    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'Business context required');
    }
    const businessId = user.business_id;

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

    const fields: Record<string, string> = {};
    if (!DATE_RE.test(date)) fields.date = 'must be YYYY-MM-DD';
    if (!HHMM_RE.test(start)) fields.start = 'must be HH:MM';
    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0)
      fields.duration_minutes = 'must be a positive integer';
    // Parity with create: an appointment starts and ends on the same day.
    if (!fields.start && !fields.duration_minutes && crossesMidnight(start, durationMinutes)) {
      fields.duration_minutes = 'start + duration must not cross midnight';
    }
    if (Object.keys(fields).length > 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid reschedule input', fields);
    }

    const serviceDefaultPriceArs = await getServiceDefaultPrice(pool, serviceId, businessId);
    if (serviceDefaultPriceArs == null) {
      return sendError(res, 404, 'not_found', 'Service not found in this business');
    }

    const clientUserId = Number(row.client_user_id);
    let clientOverridePriceArs: string | null = null;
    if (Number.isInteger(clientUserId) && clientUserId > 0) {
      clientOverridePriceArs = await getClientOverridePrice(pool, clientUserId, professionalUserId, serviceId, businessId);
    }

    const { effective_price, effective_duration_minutes } = resolveBooking({
      serviceDefaultPriceArs,
      clientOverridePriceArs,
      slotGranularityMinutes: durationMinutes,
    });

    const override = req.body?.override === true;
    const startsAt = buildStartsAt(date, start);

    const outcome = await saveWithConflictRecheck(
      pool,
      { businessId, professionalUserId, resourceId, date, start, durationMinutes: effective_duration_minutes, excludeAppointmentId: id },
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

  app.post('/api/appointments/:id/transition', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;
    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'Business context required');
    }
    const businessId = user.business_id;

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

    if (to === 'completed' || to === 'no_show') {
      const startsAt = new Date(String(row.starts_at)).getTime();
      if (Date.now() < startsAt) {
        return sendError(
          res, 422, 'too_early',
          `Cannot mark '${to}' before the appointment's start time`,
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

  app.patch('/api/appointments/:id', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;
    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'Business context required');
    }
    const businessId = user.business_id;

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

  // Distinct client ids the caller has any appointment with, in their role scope. Backs the
  // "clients with a prior relationship" list without shipping the whole appointment history to
  // the browser. Registered before /:id so the literal path wins.
  app.get('/api/appointments/related-clients', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;
    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'Business context required');
    }
    const businessId = user.business_id;
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

  app.get('/api/appointments/:id', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;
    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'Business context required');
    }
    const businessId = user.business_id;

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

  app.get('/api/appointments', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;
    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'Business context required');
    }
    const businessId = user.business_id;

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const offset = (page - 1) * limit;

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

    const { rows, total } = await listAppointments(pool, {
      businessId,
      roleScope,
      dateFrom,
      dateTo,
      professionalUserId,
      resourceId,
      clientUserId,
      state,
      limit,
      offset,
    });

    const data = user.role === 'Client' ? rows.map(stripStaffFields) : rows;

    return sendList(res, data, { page, limit, total });
  }));
}
