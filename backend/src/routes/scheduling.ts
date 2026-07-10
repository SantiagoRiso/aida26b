import express from 'express';
import type { Request, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { sendData, sendError } from '../status_messages';
import { guardRoute } from '../helpers';
import type { AuthUser } from '../auth';
import { evaluateConflicts, resolveBooking } from '../../../shared/src/ssot/domain';
import type { ConflictVerdict } from '../../../shared/src/ssot/domain';
import { getServiceDefaultPrice, getClientOverridePrice } from '../db/catalog';
import { DATE_RE, HHMM_RE, addMinutes, crossesMidnight } from '../time';
import { loadOwnerState, loadConflictInputs, toAggregatorOwner } from '../services/scheduling';
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
