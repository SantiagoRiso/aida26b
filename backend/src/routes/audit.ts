import express from 'express';
import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import { sendError, sendList } from '../status_messages';
import { guardRoute } from '../helpers';
import { authenticatedUser } from '../session';
import type { AuditWriter } from '../audit';
import { requireBusinessContext } from './business-context';
import { listAuditEvents } from '../db/audit';
import { AUDIT_OUTCOME_VALUES } from '../../../shared/src/ssot/domain';
import { DATE_OR_ISO_RE } from '../time';
import { parsePagination } from './pagination';
import { AUDIT_PATTERNS } from '../../../shared/src/ssot/api-paths';

export function mountAuditRoutes(
  app: express.Application,
  pool: Pool,
  guards: { auth: RequestHandler; passwordReady: RequestHandler; audit: AuditWriter },
) {
  // Scoped to the session business; business_id is seeded from the session, never the request body.
  app.get(AUDIT_PATTERNS.list, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);

    if (user.role !== 'Admin') {
      await guards.audit(req, 'permission_denied', 'denied', {
        path: req.path,
        method: req.method,
      });
      return sendError(res, 403, 'forbidden', 'Admin access required');
    }

    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

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

    const { limit, page, offset } = parsePagination(req.query);

    const { rows, total } = await listAuditEvents(pool, {
      businessId,
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
}
