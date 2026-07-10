import express from 'express';
import type { Request, RequestHandler } from 'express';
import { Pool } from 'pg';
import { sendData, sendError, sendList } from '../status_messages';
import { guardRoute } from '../helpers';
import type { AuthUser } from '../auth';
import type { ColumnValue } from '../../../shared/src/types/types';
import { findActiveProfessional, findActiveUser } from '../db/users';
import {
  insertCalendarGrant,
  findGrantWithBusiness,
  deleteCalendarGrant,
  listCalendarGrants,
} from '../db/grants';

type AuthedRequest = Request & { user?: AuthUser };

// Audit function signature — passed in to avoid a circular import on server.ts.
type AuditFn = (
  req: Request,
  eventType: string,
  outcome: string,
  details?: Record<string, ColumnValue>
) => Promise<void>;

export function mountGrantRoutes(
  app: express.Application,
  pool: Pool,
  guards: { auth: RequestHandler; passwordReady: RequestHandler; audit: AuditFn }
) {
  // Binary grant creation: presence of a row = access. No permission columns.
  app.post('/api/calendar-grants', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
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

    const professionalUserId = req.body.professional_user_id;
    const granteeUserId = req.body.grantee_user_id;

    if (!professionalUserId || !granteeUserId) {
      return sendError(res, 400, 'invalid_request', 'professional_user_id and grantee_user_id are required');
    }

    if (user.role === 'Professional' && Number(professionalUserId) !== user.id) {
      await guards.audit(req, 'grant_denied', 'denied', { reason: 'own_calendar_only' });
      return sendError(res, 403, 'forbidden', 'Professional may only manage their own calendar grants');
    }

    const pro = await findActiveProfessional(pool, professionalUserId);
    if (!pro || pro.business_id == null || Number(pro.business_id) !== user.business_id) {
      return sendError(res, 404, 'not_found', 'Professional not found in this business');
    }

    const grantee = await findActiveUser(pool, granteeUserId);
    if (!grantee || grantee.business_id == null || Number(grantee.business_id) !== user.business_id) {
      return sendError(res, 422, 'invalid_request', 'Grantee not found in this business');
    }
    if (grantee.role !== 'Receptionist' && grantee.role !== 'Professional') {
      return sendError(res, 422, 'invalid_request', 'Grantee must be staff (Receptionist or Professional)');
    }

    // A duplicate grant surfaces as a DbError(23505) → 409 via guardRoute's SQLSTATE mapping.
    const grant = await insertCalendarGrant(pool, professionalUserId, granteeUserId);
    if (!grant) return sendError(res, 500, 'internal_error', 'Internal server error');

    await guards.audit(req, 'grant_created', 'success', {
      entity_type: 'calendar_grants',
      entity_id: Number(grant.id),
      professional_user_id: professionalUserId,
      grantee_user_id: granteeUserId,
    });

    return sendData(res, grant, 201);
  }));

  // Revoke = delete the row; no soft-delete for grants.
  app.delete('/api/calendar-grants/:id', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
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

    const grant = await findGrantWithBusiness(pool, grantId);
    if (!grant) {
      return sendError(res, 404, 'not_found', 'Grant not found');
    }

    // Cross-business grants are invisible — return 404, not 403, to avoid leaking existence.
    if (grant.business_id == null || Number(grant.business_id) !== user.business_id) {
      return sendError(res, 404, 'not_found', 'Grant not found');
    }

    if (user.role === 'Professional' && Number(grant.professional_user_id) !== user.id) {
      return sendError(res, 403, 'forbidden', 'Professional may only revoke their own calendar grants');
    }

    await deleteCalendarGrant(pool, grantId);

    await guards.audit(req, 'grant_revoked', 'success', {
      entity_type: 'calendar_grants',
      entity_id: grantId,
      professional_user_id: grant.professional_user_id,
      grantee_user_id: grant.grantee_user_id,
    });

    return sendData(res, { id: grant.id, revoked: true });
  }));

  app.get('/api/calendar-grants', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;

    // Staff-internal data: clients have no business seeing who can manage which calendar.
    if (user.role === 'Client') {
      return sendError(res, 403, 'forbidden', 'Staff access required');
    }
    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'A business context is required');
    }

    const onlyProfessionalId =
      user.role === 'Professional'
        ? user.id
        : req.query.professional_user_id
          ? String(req.query.professional_user_id)
          : undefined;

    const grants = await listCalendarGrants(pool, {
      businessId: user.business_id,
      onlyProfessionalId,
    });

    await guards.audit(req, 'grant_listed', 'success', { count: grants.length });

    return sendList(res, grants, { page: 1, limit: grants.length, total: grants.length });
  }));
}
