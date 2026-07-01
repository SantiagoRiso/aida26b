import express from 'express';
import type { Request, RequestHandler } from 'express';
import type { Pool, PoolClient } from 'pg';
import { sendData, sendError, sendList } from '../status_messages';
import type { AuthUser } from '../auth';
import {
  resolveBooking,
  TERMINAL_STATES,
  assertValidTransition,
} from '../../../shared/src/ssot/domain';
import { recheckConflictsInTx } from './scheduling';
import { assertAppointmentActionAllowed, auditInTx } from './appointment-authz';

type AuthedRequest = Request & { user?: AuthUser };

type AuditFn = (
  req: Request,
  eventType: string,
  outcome: string,
  details?: Record<string, unknown>,
) => Promise<void>;

const BUSINESS_TZ = 'America/Argentina/Buenos_Aires';

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_OR_ISO_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?([+-]\d{2}:?\d{2})?)?$/;

function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const STAFF_ONLY_FIELDS = ['staff_note', 'override_actor_id'] as const;

function stripStaffFields(row: Record<string, unknown>): Record<string, unknown> {
  const r = { ...row };
  for (const f of STAFF_ONLY_FIELDS) delete r[f];
  return r;
}

async function resolveAndLoadService(
  pool: Pool | PoolClient,
  businessId: number,
  body: Record<string, unknown>,
): Promise<
  | {
      ok: true;
      professionalUserId: number;
      serviceId: number;
      date: string;
      start: string;
      durationMinutes: number;
      resourceId: number | undefined;
      clientUserId: number | null;
      name: string | null;
      description: string | null;
      startsAt: string;
      effective_price: string;
      effective_duration_minutes: number;
      serviceDefaultPriceArs: string;
    }
  | { ok: false; status: number; code: string; message: string; fields?: Record<string, string> }
> {
  const professionalUserId = Number(body.professional_user_id);
  const serviceId = Number(body.service_id);
  const date = typeof body.date === 'string' ? body.date : '';
  const start = typeof body.start === 'string' ? body.start : '';
  const durationMinutes = Number(body.duration_minutes);
  const resourceId =
    body.resource_id == null || body.resource_id === ''
      ? undefined
      : Number(body.resource_id);
  const clientUserId =
    body.client_user_id != null ? Number(body.client_user_id) : null;
  const name = typeof body.name === 'string' ? body.name : null;
  const description = typeof body.description === 'string' ? body.description : null;

  const fields: Record<string, string> = {};
  if (!Number.isInteger(professionalUserId) || professionalUserId <= 0)
    fields.professional_user_id = 'required';
  if (!Number.isInteger(serviceId) || serviceId <= 0) fields.service_id = 'required';
  if (!DATE_RE.test(date)) fields.date = 'must be YYYY-MM-DD';
  if (!HHMM_RE.test(start)) fields.start = 'must be HH:MM';
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0)
    fields.duration_minutes = 'must be a positive integer';
  if (!fields.start && !fields.duration_minutes) {
    const startMin =
      Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5));
    if (startMin + durationMinutes > 24 * 60)
      fields.duration_minutes = 'start + duration must not cross midnight';
  }

  if (Object.keys(fields).length > 0) {
    return { ok: false, status: 422, code: 'invalid_request', message: 'Invalid appointment input', fields };
  }

  const svc = await pool.query<{ default_price_ars: string }>(
    `SELECT default_price_ars FROM services
     WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`,
    [serviceId, businessId],
  );
  if (svc.rows.length === 0) {
    return { ok: false, status: 404, code: 'not_found', message: 'Service not found in this business' };
  }

  // Resource (when supplied) must belong to the session's business — an explicit
  // check independent of the conflict loader so a future override bypass cannot
  // write a foreign resource_id.
  if (resourceId !== undefined && Number.isInteger(resourceId)) {
    const resourceCheck = await pool.query<{ id: string }>(
      `SELECT id FROM resources WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`,
      [resourceId, businessId],
    );
    if (resourceCheck.rows.length === 0) {
      return { ok: false, status: 404, code: 'not_found', message: 'Resource not found in this business' };
    }
  }

  // Client (when supplied) must belong to the session's business — a body-supplied
  // client_user_id from another tenant is rejected before it reaches the INSERT.
  if (clientUserId != null && Number.isInteger(clientUserId)) {
    const clientCheck = await pool.query<{ id: string }>(
      `SELECT id FROM auth.users
       WHERE id = $1 AND role = 'Client' AND business_id = $2`,
      [clientUserId, businessId],
    );
    if (clientCheck.rows.length === 0) {
      return { ok: false, status: 404, code: 'not_found', message: 'Client not found in this business' };
    }
  }

  // Per-client override price, business-scoped to prevent cross-tenant price reads.
  let clientOverridePriceArs: string | null = null;
  if (clientUserId != null && Number.isInteger(clientUserId)) {
    const ov = await pool.query<{ price_ars: string }>(
      `SELECT cps.price_ars
       FROM client_professional_services cps
       JOIN auth.users u ON u.id = cps.client_user_id
       WHERE cps.client_user_id       = $1
         AND cps.professional_user_id = $2
         AND cps.service_id           = $3
         AND u.business_id            = $4`,
      [clientUserId, professionalUserId, serviceId, businessId],
    );
    clientOverridePriceArs = ov.rows[0]?.price_ars ?? null;
  }

  const serviceDefaultPriceArs = svc.rows[0].default_price_ars;
  const { effective_price, effective_duration_minutes } = resolveBooking({
    serviceDefaultPriceArs,
    clientOverridePriceArs,
    slotGranularityMinutes: durationMinutes,
  });

  const startsAt = `${date} ${start}:00 ${BUSINESS_TZ}`;

  return {
    ok: true,
    professionalUserId,
    serviceId,
    date,
    start,
    durationMinutes,
    resourceId,
    clientUserId,
    name,
    description,
    startsAt,
    effective_price,
    effective_duration_minutes,
    serviceDefaultPriceArs,
  };
}

// Loads an appointment row scoped to the session business via a JOIN through auth.users on
// professional_user_id. Returns null when the row does not exist or belongs to another tenant
// (both surface as 404 to hide cross-tenant existence).
async function loadAppointment(
  pool: Pool,
  id: number,
  businessId: number,
): Promise<Record<string, unknown> | null> {
  const r = await pool.query<Record<string, unknown>>(
    `SELECT a.*
     FROM appointments a
     JOIN auth.users u ON u.id = a.professional_user_id
     WHERE a.id = $1 AND u.business_id = $2`,
    [id, businessId],
  );
  return r.rows[0] ?? null;
}

export function mountAppointmentRoutes(
  app: express.Application,
  pool: Pool,
  guards: { auth: RequestHandler; passwordReady: RequestHandler; audit: AuditFn },
) {
  app.post('/api/appointments/request', guards.auth, guards.passwordReady, async (req, res) => {
    const user = (req as AuthedRequest).user!;

    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'Business context required');
    }
    if (user.role !== 'Client') {
      return sendError(res, 403, 'forbidden', 'Only clients may use the request endpoint');
    }

    const body = req.body ?? {};
    // Client is always the caller; ignore any body-supplied client_user_id.
    body.client_user_id = user.id;

    const resolved = await resolveAndLoadService(pool, user.business_id, body);
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
    const { loadConflictInputs } = await import('./scheduling');
    const inputs = await loadConflictInputs(pool, user.business_id, {
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

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const insert = await client.query<Record<string, unknown>>(
        `INSERT INTO appointments
           (client_user_id, professional_user_id, service_id,
            starts_at, duration_minutes, state, price,
            override_conflict, override_actor_id, name, description)
         VALUES ($1, $2, $3, $4, $5, 'requested', $6, false, null, $7, $8)
         RETURNING *`,
        [
          user.id,
          professionalUserId,
          serviceId,
          startsAt,
          effective_duration_minutes,
          effective_price,
          name,
          description,
        ],
      );
      const appt = insert.rows[0];

      await auditInTx(client, user, 'appointment_requested', 'success', Number(appt.id));

      await client.query('COMMIT');
      return sendData(res, stripStaffFields(appt), 201);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  app.post('/api/appointments/schedule', guards.auth, guards.passwordReady, async (req, res) => {
    const user = (req as AuthedRequest).user!;

    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'Business context required');
    }

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

    const resolved = await resolveAndLoadService(pool, user.business_id, body);
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

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const verdict = await recheckConflictsInTx(client, {
        businessId: user.business_id,
        professionalUserId,
        resourceId,
        date,
        start,
        durationMinutes: effective_duration_minutes,
        callerIsStaff: true,
      });

      if (verdict.requires_override && !override) {
        // Warn first; do NOT commit.
        await client.query('ROLLBACK');
        return sendData(res, verdict);
      }

      const insert = await client.query<Record<string, unknown>>(
        `INSERT INTO appointments
           (client_user_id, professional_user_id, resource_id, service_id,
            starts_at, duration_minutes, state, price,
            override_conflict, override_actor_id, name, description)
         VALUES ($1, $2, $3, $4, $5, $6, 'scheduled', $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          clientUserId,
          professionalUserId,
          resourceId ?? null,
          serviceId,
          startsAt,
          effective_duration_minutes,
          effective_price,
          override,
          override ? user.id : null,
          name,
          description,
        ],
      );
      const appt = insert.rows[0];

      await auditInTx(client, user, 'appointment_scheduled', 'success', Number(appt.id));

      await client.query('COMMIT');
      return sendData(res, appt, 201);
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      // Propagate structured status from recheckConflictsInTx loader errors (e.g. owner gone).
      if (typeof err === 'object' && err !== null && 'status' in err) {
        const e = err as { status: number; code: string; message: string };
        return sendError(res, e.status, e.code, e.message);
      }
      throw err;
    } finally {
      client.release();
    }
  });

  app.post('/api/appointments/:id/approve', guards.auth, guards.passwordReady, async (req, res) => {
    const user = (req as AuthedRequest).user!;
    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'Business context required');
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid appointment id');
    }

    const row = await loadAppointment(pool, id, user.business_id);
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

    // Derive wall-clock date + start in SQL (mirrors how scheduling.ts reads
    // booked slot times) — avoids locale-string round-trips that can drift at
    // DST-style timezone boundaries.
    const wallClock = await pool.query<{ date_str: string; start_str: string }>(
      `SELECT to_char(starts_at AT TIME ZONE $1, 'YYYY-MM-DD') AS date_str,
              to_char(starts_at AT TIME ZONE $1, 'HH24:MI')   AS start_str
       FROM appointments WHERE id = $2`,
      [BUSINESS_TZ, id],
    );
    const dateStr = wallClock.rows[0].date_str;
    const startStr = wallClock.rows[0].start_str;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const verdict = await recheckConflictsInTx(client, {
        businessId: user.business_id,
        professionalUserId: Number(row.professional_user_id),
        resourceId,
        date: dateStr,
        start: startStr,
        durationMinutes: Number(row.duration_minutes),
        callerIsStaff: true,
        excludeAppointmentId: id,
      });

      if (verdict.requires_override && !override) {
        await client.query('ROLLBACK');
        return sendData(res, verdict);
      }

      const updated = await client.query<Record<string, unknown>>(
        `UPDATE appointments
         SET state = 'scheduled',
             override_conflict = $1,
             override_actor_id = $2
         WHERE id = $3
         RETURNING *`,
        [override, override ? user.id : row.override_actor_id ?? null, id],
      );
      const appt = updated.rows[0];

      await auditInTx(client, user, 'appointment_approved', 'success', id);

      await client.query('COMMIT');
      return sendData(res, appt);
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      if (typeof err === 'object' && err !== null && 'status' in err) {
        const e = err as { status: number; code: string; message: string };
        return sendError(res, e.status, e.code, e.message);
      }
      throw err;
    } finally {
      client.release();
    }
  });

  app.post('/api/appointments/:id/reschedule', guards.auth, guards.passwordReady, async (req, res) => {
    const user = (req as AuthedRequest).user!;
    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'Business context required');
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid appointment id');
    }

    const row = await loadAppointment(pool, id, user.business_id);
    if (!row) return sendError(res, 404, 'not_found', 'Appointment not found');

    // Authz before state check: unauthorized callers get 403 regardless of the
    // appointment's state — prevents probing terminal vs. actionable via 422 vs. 403.
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

    // Parse date + start from the request body, or fall back to the stored
    // starts_at derived in SQL (mirrors scheduling.ts — no locale-string round-trip).
    let date: string;
    let start: string;
    if (body.date && body.start) {
      date = String(body.date);
      start = String(body.start);
    } else {
      const wc = await pool.query<{ date_str: string; start_str: string }>(
        `SELECT to_char(starts_at AT TIME ZONE $1, 'YYYY-MM-DD') AS date_str,
                to_char(starts_at AT TIME ZONE $1, 'HH24:MI')   AS start_str
         FROM appointments WHERE id = $2`,
        [BUSINESS_TZ, id],
      );
      date = wc.rows[0].date_str;
      start = wc.rows[0].start_str;
    }

    const durationMinutes = body.duration_minutes != null
      ? Number(body.duration_minutes)
      : Number(row.duration_minutes);

    const fields: Record<string, string> = {};
    if (!DATE_RE.test(date)) fields.date = 'must be YYYY-MM-DD';
    if (!HHMM_RE.test(start)) fields.start = 'must be HH:MM';
    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0)
      fields.duration_minutes = 'must be a positive integer';
    if (Object.keys(fields).length > 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid reschedule input', fields);
    }

    const svc = await pool.query<{ default_price_ars: string }>(
      `SELECT default_price_ars FROM services
       WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`,
      [serviceId, user.business_id],
    );
    if (svc.rows.length === 0) {
      return sendError(res, 404, 'not_found', 'Service not found in this business');
    }

    const clientUserId = Number(row.client_user_id);
    let clientOverridePriceArs: string | null = null;
    if (Number.isInteger(clientUserId) && clientUserId > 0) {
      const ov = await pool.query<{ price_ars: string }>(
        `SELECT cps.price_ars
         FROM client_professional_services cps
         JOIN auth.users u ON u.id = cps.client_user_id
         WHERE cps.client_user_id       = $1
           AND cps.professional_user_id = $2
           AND cps.service_id           = $3
           AND u.business_id            = $4`,
        [clientUserId, professionalUserId, serviceId, user.business_id],
      );
      clientOverridePriceArs = ov.rows[0]?.price_ars ?? null;
    }

    const { effective_price, effective_duration_minutes } = resolveBooking({
      serviceDefaultPriceArs: svc.rows[0].default_price_ars,
      clientOverridePriceArs,
      slotGranularityMinutes: durationMinutes,
    });

    const override = req.body?.override === true;
    const startsAt = `${date} ${start}:00 ${BUSINESS_TZ}`;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const verdict = await recheckConflictsInTx(client, {
        businessId: user.business_id,
        professionalUserId,
        resourceId,
        date,
        start,
        durationMinutes: effective_duration_minutes,
        callerIsStaff: true,
        excludeAppointmentId: id,
      });

      if (verdict.requires_override && !override) {
        await client.query('ROLLBACK');
        return sendData(res, verdict);
      }

      const updated = await client.query<Record<string, unknown>>(
        `UPDATE appointments
         SET professional_user_id = $1,
             service_id            = $2,
             resource_id           = $3,
             starts_at             = $4,
             duration_minutes      = $5,
             price                 = $6,
             override_conflict     = $7,
             override_actor_id     = $8,
             name                  = COALESCE($9, name),
             description           = COALESCE($10, description)
         WHERE id = $11
         RETURNING *`,
        [
          professionalUserId,
          serviceId,
          resourceId ?? null,
          startsAt,
          effective_duration_minutes,
          effective_price,
          override,
          override ? user.id : null,
          body.name ?? null,
          body.description ?? null,
          id,
        ],
      );
      const appt = updated.rows[0];

      await auditInTx(client, user, 'appointment_rescheduled', 'success', id);

      await client.query('COMMIT');
      return sendData(res, appt);
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      if (typeof err === 'object' && err !== null && 'status' in err) {
        const e = err as { status: number; code: string; message: string };
        return sendError(res, e.status, e.code, e.message);
      }
      throw err;
    } finally {
      client.release();
    }
  });

  app.post('/api/appointments/:id/transition', guards.auth, guards.passwordReady, async (req, res) => {
    const user = (req as AuthedRequest).user!;
    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'Business context required');
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid appointment id');
    }

    const to = typeof req.body?.to === 'string' ? req.body.to : '';
    if (!to) {
      return sendError(res, 422, 'invalid_request', 'Field "to" is required');
    }

    const row = await loadAppointment(pool, id, user.business_id);
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
        const cutoffRow = await pool.query<{ cancellation_cutoff_hours: number }>(
          `SELECT b.cancellation_cutoff_hours
           FROM businesses b
           JOIN auth.users u ON u.business_id = b.id
           WHERE u.id = $1 LIMIT 1`,
          [user.id],
        );
        const cutoffHours = cutoffRow.rows[0]?.cancellation_cutoff_hours ?? 24;
        const cutoffMs = cutoffHours * 60 * 60 * 1000;
        const startsAt = new Date(String(row.starts_at)).getTime();
        if (Date.now() > startsAt - cutoffMs) {
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

    const pgClient = await pool.connect();
    try {
      await pgClient.query('BEGIN');

      const updated = await pgClient.query<Record<string, unknown>>(
        `UPDATE appointments SET state = $1 WHERE id = $2 RETURNING *`,
        [to, id],
      );
      const appt = updated.rows[0];

      await auditInTx(pgClient, user, `appointment_${to}`, 'success', id);

      await pgClient.query('COMMIT');

      if (user.role === 'Client') {
        return sendData(res, stripStaffFields(appt));
      }
      return sendData(res, appt);
    } catch (err) {
      await pgClient.query('ROLLBACK');
      throw err;
    } finally {
      pgClient.release();
    }
  });

  app.patch('/api/appointments/:id', guards.auth, guards.passwordReady, async (req, res) => {
    const user = (req as AuthedRequest).user!;
    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'Business context required');
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid appointment id');
    }

    const row = await loadAppointment(pool, id, user.business_id);
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

    const setClauses: string[] = [];
    const params: unknown[] = [];
    let p = 1;

    if (name !== undefined) { setClauses.push(`name = $${p++}`); params.push(name); }
    if (description !== undefined) { setClauses.push(`description = $${p++}`); params.push(description); }
    if (staffNote !== undefined) { setClauses.push(`staff_note = $${p++}`); params.push(staffNote); }

    if (setClauses.length === 0) {
      return sendError(res, 422, 'invalid_request', 'No editable fields provided');
    }

    params.push(id);

    // Wrap UPDATE + audit in a transaction so a failed audit never leaves a
    // committed edit with no audit trail — matches the durability invariant of
    // every other appointment mutation in this module.
    const pgClient = await pool.connect();
    try {
      await pgClient.query('BEGIN');

      const updated = await pgClient.query<Record<string, unknown>>(
        `UPDATE appointments SET ${setClauses.join(', ')} WHERE id = $${p} RETURNING *`,
        params,
      );

      await auditInTx(pgClient, user, 'appointment_patched', 'success', id, 'appointments', {
        fields: Object.keys(body).filter((k) => ['name', 'description', 'staff_note'].includes(k)),
      });

      await pgClient.query('COMMIT');
      return sendData(res, updated.rows[0]);
    } catch (err) {
      await pgClient.query('ROLLBACK');
      throw err;
    } finally {
      pgClient.release();
    }
  });

  app.get('/api/appointments/:id', guards.auth, guards.passwordReady, async (req, res) => {
    const user = (req as AuthedRequest).user!;
    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'Business context required');
    }

    // Clients use /api/appointments (filtered list) + /api/availability.
    if (user.role === 'Client') {
      return sendError(res, 403, 'forbidden', 'Clients may not access the appointment detail view');
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid appointment id');
    }

    const row = await loadAppointment(pool, id, user.business_id);
    if (!row) return sendError(res, 404, 'not_found', 'Appointment not found');

    const authz = await assertAppointmentActionAllowed(pool, user, Number(row.professional_user_id));
    if (!authz.ok) {
      return sendError(res, authz.status, authz.code, authz.message);
    }

    return sendData(res, row);
  });

  app.get('/api/appointments', guards.auth, guards.passwordReady, async (req, res) => {
    const user = (req as AuthedRequest).user!;
    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'Business context required');
    }

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const offset = (page - 1) * limit;

    // All filter values go through parameterized $N — never string-interpolated.
    const conditions: string[] = [`u.business_id = $1`];
    const params: unknown[] = [user.business_id];
    let p = 2;

    if (user.role === 'Client') {
      conditions.push(`a.client_user_id = $${p++}`);
      params.push(user.id);
    } else if (user.role === 'Professional') {
      conditions.push(`a.professional_user_id = $${p++}`);
      params.push(user.id);
    } else if (user.role === 'Receptionist') {
      conditions.push(
        `a.professional_user_id IN (
           SELECT professional_user_id FROM calendar_grants WHERE grantee_user_id = $${p++}
         )`,
      );
      params.push(user.id);
    }

    if (req.query.date_from) {
      if (!DATE_OR_ISO_RE.test(String(req.query.date_from))) {
        return sendError(res, 422, 'invalid_request', 'date_from must be a date (YYYY-MM-DD) or ISO timestamp');
      }
      conditions.push(`a.starts_at >= $${p++}`);
      params.push(req.query.date_from);
    }
    if (req.query.date_to) {
      if (!DATE_OR_ISO_RE.test(String(req.query.date_to))) {
        return sendError(res, 422, 'invalid_request', 'date_to must be a date (YYYY-MM-DD) or ISO timestamp');
      }
      conditions.push(`a.starts_at <= $${p++}`);
      params.push(req.query.date_to);
    }
    if (req.query.professional_user_id) {
      conditions.push(`a.professional_user_id = $${p++}`);
      params.push(Number(req.query.professional_user_id));
    }
    if (req.query.resource_id) {
      conditions.push(`a.resource_id = $${p++}`);
      params.push(Number(req.query.resource_id));
    }

    const where = conditions.join(' AND ');

    const [rows, count] = await Promise.all([
      pool.query<Record<string, unknown>>(
        `SELECT a.*
         FROM appointments a
         JOIN auth.users u ON u.id = a.professional_user_id
         WHERE ${where}
         ORDER BY a.starts_at
         LIMIT $${p} OFFSET $${p + 1}`,
        [...params, limit, offset],
      ),
      pool.query<{ n: string }>(
        `SELECT count(*)::text AS n
         FROM appointments a
         JOIN auth.users u ON u.id = a.professional_user_id
         WHERE ${where}`,
        params,
      ),
    ]);

    const data =
      user.role === 'Client'
        ? rows.rows.map(stripStaffFields)
        : rows.rows;

    return sendList(res, data, { page, limit, total: Number(count.rows[0].n) });
  });
}
