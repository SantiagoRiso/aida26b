import express from 'express';
import type { Request, RequestHandler } from 'express';
import { Pool } from 'pg';
import { sendData, sendError } from '../status_messages';
import type { AuthUser } from '../auth';
import { assertOwnScheduleAllowed } from './crud-policy';
import { validateWeeklySchedule } from '../../../shared/src/ssot/domain';

type AuthedRequest = Request & { user?: AuthUser };

type AuditFn = (
  req: Request,
  eventType: string,
  outcome: string,
  details?: Record<string, unknown>
) => Promise<void>;

// Dedicated set-weekly-schedule endpoint (D-14): validates the per-block-granularity weekly JSON
// in the domain layer (SQL treats weekly as opaque JSONB), enforces the one-owner rule, applies
// the own-schedule authz guard, and upserts the single schedules row for the owner.
export function mountSetScheduleRoutes(
  app: express.Application,
  pool: Pool,
  guards: { auth: RequestHandler; passwordReady: RequestHandler; audit: AuditFn }
) {
  app.post('/api/schedule', guards.auth, guards.passwordReady, async (req, res) => {
    const user = (req as AuthedRequest).user!;

    const body = req.body ?? {};
    const hasProfessional = body.professional_user_id != null && body.professional_user_id !== '';
    const hasResource = body.resource_id != null && body.resource_id !== '';

    // One-owner rule: exactly one of professional_user_id / resource_id.
    if (hasProfessional === hasResource) {
      return sendError(res, 422, 'invalid_request', 'Exactly one of professional_user_id or resource_id is required', {
        professional_user_id: 'set exactly one owner',
        resource_id: 'set exactly one owner',
      });
    }

    const validated = validateWeeklySchedule(body.weekly);
    if (!validated.ok) {
      return sendError(res, 422, 'invalid_request', 'Invalid weekly schedule', {
        weekly: validated.errors.join('; '),
      });
    }

    const target = {
      professional_user_id: hasProfessional ? Number(body.professional_user_id) : null,
      resource_id: hasResource ? Number(body.resource_id) : null,
    };

    const guard = await assertOwnScheduleAllowed(pool, user, target);
    if (!guard.ok) {
      await guards.audit(req, 'schedule_update_denied', 'denied', { reason: guard.code });
      return sendError(res, guard.status, guard.code, guard.message);
    }

    // Upsert the single schedules row for this owner. weekly is stored opaque; the validated
    // object is JSON.stringify'd into one bound param (no SQL-side JSON construction).
    const ownerCol = target.professional_user_id != null ? 'professional_user_id' : 'resource_id';
    const ownerId = target.professional_user_id != null ? target.professional_user_id : target.resource_id;

    const result = await pool.query<{ id: string; weekly: unknown }>(
      `INSERT INTO schedules (${ownerCol}, weekly)
       VALUES ($1, $2)
       ON CONFLICT (${ownerCol}) DO UPDATE SET weekly = EXCLUDED.weekly, updated_at = now()
       RETURNING id, weekly`,
      [ownerId, JSON.stringify(validated.value)]
    );

    await guards.audit(req, 'schedule_updated', 'success', {
      entity_type: 'schedules',
      entity_id: Number(result.rows[0].id),
      [ownerCol]: ownerId,
    });

    return sendData(res, result.rows[0]);
  });
}
