import express from 'express';
import type { Request, RequestHandler } from 'express';
import { Pool } from 'pg';
import { sendData, sendError, sendList } from '../status_messages';
import type { AuthUser } from '../auth';
import { auditInTx } from './appointment-authz';

// Accepts YYYY-MM-DD or ISO 8601 timestamp (date + T + time + optional Z/offset).
const DATE_OR_ISO_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?([+-]\d{2}:?\d{2})?)?$/;

type AuthedRequest = Request & { user?: AuthUser };

type AuditFn = (
  req: Request,
  eventType: string,
  outcome: string,
  details?: Record<string, unknown>,
) => Promise<void>;

// businesses is deliberately excluded from generic CRUD. This module owns the only
// writable surface for business config: a single cutoff-only PATCH endpoint.
export function mountAuditRoutes(
  app: express.Application,
  pool: Pool,
  guards: { auth: RequestHandler; passwordReady: RequestHandler; audit: AuditFn },
) {
  // Scoped to the session business; business_id is seeded from the session, never the request body.
  app.get('/api/audit', guards.auth, guards.passwordReady, async (req, res) => {
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

    // Only code-controlled column names are interpolated; all user-supplied filter
    // values are bound as $N params — no SQL injection risk from column names.
    const conditions: string[] = ['a.business_id = $1'];
    const params: unknown[] = [user.business_id];
    let paramIdx = 2;

    if (req.query.entity_type) {
      conditions.push(`a.entity_type = $${paramIdx}`);
      params.push(req.query.entity_type);
      paramIdx++;
    }

    if (req.query.actor_user_id) {
      const actorId = Number(req.query.actor_user_id);
      if (Number.isInteger(actorId) && actorId > 0) {
        conditions.push(`a.actor_user_id = $${paramIdx}`);
        params.push(actorId);
        paramIdx++;
      }
    }

    if (req.query.event_type) {
      conditions.push(`a.event_type = $${paramIdx}`);
      params.push(req.query.event_type);
      paramIdx++;
    }

    if (req.query.date_from) {
      if (!DATE_OR_ISO_RE.test(String(req.query.date_from))) {
        return sendError(res, 422, 'invalid_request', 'date_from must be a date (YYYY-MM-DD) or ISO timestamp');
      }
      conditions.push(`a.created_at >= $${paramIdx}`);
      params.push(req.query.date_from);
      paramIdx++;
    }

    if (req.query.date_to) {
      if (!DATE_OR_ISO_RE.test(String(req.query.date_to))) {
        return sendError(res, 422, 'invalid_request', 'date_to must be a date (YYYY-MM-DD) or ISO timestamp');
      }
      conditions.push(`a.created_at <= $${paramIdx}`);
      params.push(req.query.date_to);
      paramIdx++;
    }

    const where = conditions.join(' AND ');
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const offset = (page - 1) * limit;

    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT a.id, a.actor_user_id, a.event_type, a.entity_type, a.entity_id,
                a.outcome, a.ip, a.details, a.created_at
         FROM audit_events a
         WHERE ${where}
         ORDER BY a.created_at DESC
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset],
      ),
      pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_events a WHERE ${where}`,
        params,
      ),
    ]);

    return sendList(res, rows.rows, { page, limit, total: Number(count.rows[0].n) });
  });

  // A mismatched :id is cross-tenant — returns 404 to hide existence.
  app.get('/api/businesses/:id/settings', guards.auth, guards.passwordReady, async (req, res) => {
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

    const result = await pool.query<{ id: string; cancellation_cutoff_hours: number }>(
      `SELECT id, cancellation_cutoff_hours FROM businesses WHERE id = $1`,
      [user.business_id],
    );

    if (result.rows.length === 0) {
      return sendError(res, 404, 'not_found', 'Business not found');
    }

    return sendData(res, result.rows[0]);
  });

  // A mismatched :id is cross-tenant — returns 404 to hide existence.
  // Only cancellation_cutoff_hours is writable here.
  app.patch('/api/businesses/:id/settings', guards.auth, guards.passwordReady, async (req, res) => {
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

    const result = await pool.query<{ id: string; cancellation_cutoff_hours: number }>(
      `UPDATE businesses
       SET cancellation_cutoff_hours = $1
       WHERE id = $2
       RETURNING id, cancellation_cutoff_hours`,
      [cutoffHours, user.business_id],
    );

    if (result.rows.length === 0) {
      return sendError(res, 404, 'not_found', 'Business not found');
    }

    // No data-integrity dependency on the audit row, so guards.audit (pool) is fine here.
    await guards.audit(req, 'business_settings_updated', 'success', {
      business_id: user.business_id,
      cancellation_cutoff_hours: cutoffHours,
    });

    return sendData(res, result.rows[0]);
  });
}
