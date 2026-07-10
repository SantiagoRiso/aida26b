import express from 'express';
import type { Request, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { sendData, sendError, sendList } from '../status_messages';
import { guardRoute } from '../helpers';
import type { AuthUser } from '../auth';
import { listAuditEvents } from '../db/audit';
import { getBusinessSettings, updateBusinessCutoff } from '../db/businesses';
import type { ColumnValue } from '../../../shared/src/types/types';
import { AUDIT_OUTCOME_VALUES } from '../../../shared/src/ssot/domain';

const DATE_OR_ISO_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?([+-]\d{2}:?\d{2})?)?$/;

type AuthedRequest = Request & { user?: AuthUser };

type AuditFn = (
  req: Request,
  eventType: string,
  outcome: string,
  details?: Record<string, ColumnValue>,
) => Promise<void>;

// businesses is deliberately excluded from generic CRUD. This module owns the only
// writable surface for business config: a single cutoff-only PATCH endpoint.
export function mountAuditRoutes(
  app: express.Application,
  pool: Pool,
  guards: { auth: RequestHandler; passwordReady: RequestHandler; audit: AuditFn },
) {
  // Scoped to the session business; business_id is seeded from the session, never the request body.
  app.get('/api/audit', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;

    if (user.role !== 'Admin') {
      await guards.audit(req, 'permission_denied', 'denied', {
        path: req.path,
        method: req.method,
      });
      return sendError(res, 403, 'forbidden', 'Admin access required');
    }

    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'A business context is required');
    }

    const entityType = req.query.entity_type ? String(req.query.entity_type) : undefined;

    let actorUserId: number | undefined;
    if (req.query.actor_user_id) {
      const actorId = Number(req.query.actor_user_id);
      if (Number.isInteger(actorId) && actorId > 0) actorUserId = actorId;
    }

    const eventType = req.query.event_type ? String(req.query.event_type) : undefined;

    let outcome: string | undefined;
    if (req.query.outcome) {
      if (!AUDIT_OUTCOME_VALUES.has(String(req.query.outcome))) {
        return sendError(res, 422, 'invalid_request', 'Unknown outcome');
      }
      outcome = String(req.query.outcome);
    }

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

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const offset = (page - 1) * limit;

    const { rows, total } = await listAuditEvents(pool, {
      businessId: user.business_id,
      entityType,
      actorUserId,
      eventType,
      outcome,
      dateFrom,
      dateTo,
      limit,
      offset,
    });

    return sendList(res, rows, { page, limit, total });
  }));

  // Session-scoped, any authenticated role: the cancellation cutoff is business policy the portal
  // needs to show clients why a cancel is (un)available. Non-sensitive — no admin gate.
  app.get('/api/business/settings', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;
    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'A business context is required');
    }

    const settings = await getBusinessSettings(pool, user.business_id);
    if (!settings) {
      return sendError(res, 404, 'not_found', 'Business not found');
    }
    return sendData(res, settings);
  }));

  // A mismatched :id is cross-tenant — returns 404 to hide existence.
  app.get('/api/businesses/:id/settings', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;

    if (user.role !== 'Admin') {
      await guards.audit(req, 'permission_denied', 'denied', {
        path: req.path,
        method: req.method,
      });
      return sendError(res, 403, 'forbidden', 'Admin access required');
    }

    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'A business context is required');
    }

    const urlId = Number(req.params.id);
    if (urlId !== user.business_id) {
      return sendError(res, 404, 'not_found', 'Business not found');
    }

    const settings = await getBusinessSettings(pool, user.business_id);
    if (!settings) {
      return sendError(res, 404, 'not_found', 'Business not found');
    }
    return sendData(res, settings);
  }));

  // A mismatched :id is cross-tenant — returns 404 to hide existence.
  app.patch('/api/businesses/:id/settings', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;

    if (user.role !== 'Admin') {
      await guards.audit(req, 'permission_denied', 'denied', {
        path: req.path,
        method: req.method,
      });
      return sendError(res, 403, 'forbidden', 'Admin access required');
    }

    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'A business context is required');
    }

    const urlId = Number(req.params.id);
    if (urlId !== user.business_id) {
      return sendError(res, 404, 'not_found', 'Business not found');
    }

    const rawCutoff = req.body.cancellation_cutoff_hours;
    const cutoffHours = Number(rawCutoff);
    if (
      rawCutoff === undefined ||
      rawCutoff === null ||
      !Number.isInteger(cutoffHours) ||
      cutoffHours < 0
    ) {
      return sendError(res, 422, 'invalid_request', 'cancellation_cutoff_hours must be a non-negative integer', {
        cancellation_cutoff_hours: 'required non-negative integer',
      });
    }

    const updated = await updateBusinessCutoff(pool, user.business_id, cutoffHours);
    if (!updated) {
      return sendError(res, 404, 'not_found', 'Business not found');
    }

    // No data-integrity dependency on the audit row, so guards.audit (pool) is fine here.
    await guards.audit(req, 'business_settings_updated', 'success', {
      business_id: user.business_id,
      cancellation_cutoff_hours: cutoffHours,
    });

    return sendData(res, updated);
  }));
}
