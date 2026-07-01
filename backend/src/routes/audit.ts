import express from 'express';
import type { Request, RequestHandler } from 'express';
import { Pool } from 'pg';
import { sendData, sendError, sendList } from '../status_messages';
import type { AuthUser } from '../auth';
import { auditInTx } from './appointment-authz';

type AuthedRequest = Request & { user?: AuthUser };

type AuditFn = (
  req: Request,
  eventType: string,
  outcome: string,
  details?: Record<string, unknown>,
) => Promise<void>;

// businesses is deliberately excluded from generic CRUD (Phase 1 D-14 / RESEARCH open
// question 3). This module owns the only writable surface for business config: a single
// cutoff-only PATCH endpoint that no other route module needs to duplicate.
export function mountAuditRoutes(
  app: express.Application,
  pool: Pool,
  guards: { auth: RequestHandler; passwordReady: RequestHandler; audit: AuditFn },
) {
  // Admin-only paginated, filterable audit event log (D-27, D-28, D-29).
  // Scoped to the session business; cross-tenant visibility impossible because
  // business_id is seeded from the session, never the request body (T-04-16).
  app.get('/api/audit', guards.auth, guards.passwordReady, async (req, res) => {
    const user = (req as AuthedRequest).user!;

    if (user.role !== 'Admin') {
      // Audit the denial before returning (D-28).
      await guards.audit(req, 'permission_denied', 'denied', {
        path: req.path,
        method: req.method,
      });
      return sendError(res, 403, 'forbidden', 'Admin access required');
    }

    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'A business context is required');
    }

    // Parameterized WHERE accumulator — only code-controlled column names are
    // interpolated; all user-supplied filter values are bound as $N params (T-04-17).
    const conditions: string[] = ['a.business_id = $1'];
    const params: unknown[] = [user.business_id];
    let paramIdx = 2;

    // Optional filter: entity_type (e.g. 'appointments', 'ledger_entries').
    if (req.query.entity_type) {
      conditions.push(`a.entity_type = $${paramIdx}`);
      params.push(req.query.entity_type);
      paramIdx++;
    }

    // Optional filter: actor_user_id (the user who triggered the event).
    if (req.query.actor_user_id) {
      const actorId = Number(req.query.actor_user_id);
      if (Number.isInteger(actorId) && actorId > 0) {
        conditions.push(`a.actor_user_id = $${paramIdx}`);
        params.push(actorId);
        paramIdx++;
      }
    }

    // Optional filter: event_type (e.g. 'appointment_canceled').
    if (req.query.event_type) {
      conditions.push(`a.event_type = $${paramIdx}`);
      params.push(req.query.event_type);
      paramIdx++;
    }

    // Optional date range filters on created_at (inclusive).
    if (req.query.date_from) {
      conditions.push(`a.created_at >= $${paramIdx}`);
      params.push(req.query.date_from);
      paramIdx++;
    }

    if (req.query.date_to) {
      conditions.push(`a.created_at <= $${paramIdx}`);
      params.push(req.query.date_to);
      paramIdx++;
    }

    const where = conditions.join(' AND ');
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const offset = (page - 1) * limit;

    // The view surfaces the minimal fields already on the row (D-29); no old→new
    // reconstruction. outcome includes 'denied' and 'failure' alongside 'success' (D-28).
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

  // Admin-only business settings: update only cancellation_cutoff_hours.
  // The UPDATE is scoped to WHERE id = user.business_id (session scope); a mismatched
  // :id parameter in the URL is silently treated as cross-tenant — returns 404 to hide
  // existence (T-04-19). Only cancellation_cutoff_hours is writable here (T-04-20).
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

    // Cross-tenant :id → 404 to hide existence (T-04-19).
    // The session's business_id is the authoritative scope; a caller who supplies a
    // different :id is either probing or confused — treat it as not found.
    const urlId = Number(req.params.id);
    if (urlId !== user.business_id) {
      return sendError(res, 404, 'not_found', 'Business not found');
    }

    // Validate cancellation_cutoff_hours: required, non-negative integer.
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

    // Scope to the admin's own business — cross-tenant :id → 404 (hides existence).
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

    // Audit the successful settings update in-transaction is unnecessary for a single
    // UPDATE (no data-integrity dependency on the audit row), so guards.audit is fine.
    await guards.audit(req, 'business_settings_updated', 'success', {
      business_id: user.business_id,
      cancellation_cutoff_hours: cutoffHours,
    });

    return sendData(res, result.rows[0]);
  });
}
