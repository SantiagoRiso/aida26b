import express from 'express';
import type { Request, RequestHandler } from 'express';
import { Pool } from 'pg';
import { sendData, sendError, sendList } from '../status_messages';
import type { AuthUser } from '../auth';

type AuthedRequest = Request & { user?: AuthUser };

// Audit function signature — passed in to avoid a circular import on server.ts.
type AuditFn = (
  req: Request,
  eventType: string,
  outcome: string,
  details?: Record<string, unknown>
) => Promise<void>;

export function mountGrantRoutes(
  app: express.Application,
  pool: Pool,
  guards: { auth: RequestHandler; passwordReady: RequestHandler; audit: AuditFn }
) {
  // Binary grant creation: presence of a row = access. No permission columns.
  app.post('/api/calendar-grants', guards.auth, guards.passwordReady, async (req, res) => {
    const user = (req as AuthedRequest).user!;

    // Receptionists and clients cannot manage grants.
    if (user.role === 'Receptionist' || user.role === 'Client') {
      await guards.audit(req, 'grant_denied', 'denied', { reason: 'role_forbidden' });
      return sendError(res, 403, 'forbidden', 'Insufficient role');
    }

    // Grants are tenant-bound; a super-admin (null business) has no business context.
    if (user.business_id == null) {
      await guards.audit(req, 'grant_denied', 'denied', { reason: 'no_business' });
      return sendError(res, 400, 'no_business', 'A business context is required to manage calendar grants');
    }

    const professionalUserId = req.body.professional_user_id;
    const granteeUserId = req.body.grantee_user_id;

    if (!professionalUserId || !granteeUserId) {
      return sendError(res, 400, 'invalid_request', 'professional_user_id and grantee_user_id are required');
    }

    // Professional may only grant on their own calendar.
    if (user.role === 'Professional' && Number(professionalUserId) !== user.id) {
      await guards.audit(req, 'grant_denied', 'denied', { reason: 'own_calendar_only' });
      return sendError(res, 403, 'forbidden', 'Professional may only manage their own calendar grants');
    }

    const proCheck = await pool.query<{ user_id: string; business_id: string | null }>(
      `SELECT id AS user_id, business_id
       FROM auth.users
       WHERE id = $1 AND role = 'Professional' AND is_active = true`,
      [professionalUserId]
    );

    const proBusiness = proCheck.rows[0]?.business_id;
    if (proCheck.rows.length === 0 || proBusiness == null || Number(proBusiness) !== user.business_id) {
      return sendError(res, 404, 'not_found', 'Professional not found in this business');
    }

    // Grantee must belong to the session business and be staff.
    const granteeCheck = await pool.query<{ id: string; role: string; business_id: string | null }>(
      `SELECT id, role, business_id FROM auth.users WHERE id = $1 AND is_active = true`,
      [granteeUserId]
    );

    const granteeBusiness = granteeCheck.rows[0]?.business_id;
    if (granteeCheck.rows.length === 0 || granteeBusiness == null || Number(granteeBusiness) !== user.business_id) {
      return sendError(res, 422, 'invalid_request', 'Grantee not found in this business');
    }

    const granteeRole = granteeCheck.rows[0].role;
    if (granteeRole !== 'Receptionist' && granteeRole !== 'Professional') {
      return sendError(res, 422, 'invalid_request', 'Grantee must be staff (Receptionist or Professional)');
    }

    try {
      const result = await pool.query<{
        id: string;
        professional_user_id: string;
        grantee_user_id: string;
        created_at: string;
      }>(
        `INSERT INTO calendar_grants (professional_user_id, grantee_user_id)
         VALUES ($1, $2)
         RETURNING id, professional_user_id, grantee_user_id, created_at`,
        [professionalUserId, granteeUserId]
      );

      const grant = result.rows[0];
      await guards.audit(req, 'grant_created', 'success', {
        entity_type: 'calendar_grants',
        entity_id: Number(grant.id),
        professional_user_id: professionalUserId,
        grantee_user_id: granteeUserId,
      });

      return sendData(res, grant, 201);
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === '23505'
      ) {
        return sendError(res, 409, 'conflict', 'Grant already exists');
      }
      console.error('Error creating calendar grant:', error);
      return sendError(res, 500, 'internal_error', 'Internal server error');
    }
  });

  // Revoke = delete the row; no soft-delete for grants.
  app.delete('/api/calendar-grants/:id', guards.auth, guards.passwordReady, async (req, res) => {
    const user = (req as AuthedRequest).user!;

    if (user.role === 'Receptionist' || user.role === 'Client') {
      await guards.audit(req, 'grant_denied', 'denied', { reason: 'role_forbidden' });
      return sendError(res, 403, 'forbidden', 'Insufficient role');
    }

    // Grants are tenant-bound; a super-admin (null business) has no business context.
    if (user.business_id == null) {
      await guards.audit(req, 'grant_denied', 'denied', { reason: 'no_business' });
      return sendError(res, 400, 'no_business', 'A business context is required to manage calendar grants');
    }

    const grantId = Number(req.params.id);
    if (!Number.isInteger(grantId) || grantId <= 0) {
      return sendError(res, 400, 'invalid_request', 'Valid grant id is required');
    }

    const grantCheck = await pool.query<{
      id: string;
      professional_user_id: string;
      grantee_user_id: string;
      business_id: string | null;
    }>(
      `SELECT g.id, g.professional_user_id, g.grantee_user_id, u.business_id
       FROM calendar_grants g
       JOIN auth.users u ON u.id = g.professional_user_id
       WHERE g.id = $1`,
      [grantId]
    );

    if (grantCheck.rows.length === 0) {
      return sendError(res, 404, 'not_found', 'Grant not found');
    }

    const grant = grantCheck.rows[0];

    // Cross-business grants are invisible — return 404, not 403, to avoid leaking existence.
    if (grant.business_id == null || Number(grant.business_id) !== user.business_id) {
      return sendError(res, 404, 'not_found', 'Grant not found');
    }

    // Professional may only revoke grants on their own calendar.
    if (
      user.role === 'Professional' &&
      Number(grant.professional_user_id) !== user.id
    ) {
      return sendError(res, 403, 'forbidden', 'Professional may only revoke their own calendar grants');
    }

    await pool.query('DELETE FROM calendar_grants WHERE id = $1', [grantId]);

    await guards.audit(req, 'grant_revoked', 'success', {
      entity_type: 'calendar_grants',
      entity_id: grantId,
      professional_user_id: grant.professional_user_id,
      grantee_user_id: grant.grantee_user_id,
    });

    return sendData(res, { id: grant.id, revoked: true });
  });

  // List grants scoped to the session business; Professional sees only their own.
  app.get('/api/calendar-grants', guards.auth, guards.passwordReady, async (req, res) => {
    const user = (req as AuthedRequest).user!;

    const conditions: string[] = [
      `u.business_id = $1`,
    ];
    const params: unknown[] = [user.business_id];
    let paramIdx = 2;

    // Professional sees only their own calendar's grants.
    if (user.role === 'Professional') {
      conditions.push(`g.professional_user_id = $${paramIdx}`);
      params.push(user.id);
      paramIdx++;
    }

    // Optional filter by professional_user_id (admin/receptionist use case).
    const filterProfId = req.query.professional_user_id;
    if (filterProfId && user.role !== 'Professional') {
      conditions.push(`g.professional_user_id = $${paramIdx}`);
      params.push(filterProfId);
      paramIdx++;
    }

    const where = conditions.join(' AND ');

    const result = await pool.query<{
      id: string;
      professional_user_id: string;
      grantee_user_id: string;
      created_at: string;
    }>(
      `SELECT g.id, g.professional_user_id, g.grantee_user_id, g.created_at
       FROM calendar_grants g
       JOIN auth.users u ON u.id = g.professional_user_id
       WHERE ${where}
       ORDER BY g.created_at`,
      params
    );

    await guards.audit(req, 'grant_listed', 'success', {
      count: result.rows.length,
    });

    return sendList(res, result.rows, {
      page: 1,
      limit: result.rows.length,
      total: result.rows.length,
    });
  });
}
