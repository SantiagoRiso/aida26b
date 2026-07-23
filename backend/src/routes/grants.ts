import express from 'express';
import type { RequestHandler } from 'express';
import { Pool } from 'pg';
import { sendData, sendError, sendList } from '../status_messages';
import { guardRoute } from '../helpers';
import { authenticatedUser } from '../session';
import type { AuditWriter } from '../audit';
import { requireBusinessContext, belongsToBusiness } from './business-context';
import { adminTenantScope, resolveTargetTenant } from './tenant-scope';
import { findUser } from '../db/users';
import {
  insertCalendarGrant,
  findGrantWithBusiness,
  deleteCalendarGrant,
  listCalendarGrants,
  listGrantableStaff,
  GRANTABLE_STAFF_ROLES,
} from '../db/grants';
import { GRANT_PATTERNS } from '../../../shared/src/ssot/api-paths';

export function mountGrantRoutes(
  app: express.Application,
  pool: Pool,
  guards: { auth: RequestHandler; passwordReady: RequestHandler; audit: AuditWriter }
) {
  // Binary grant creation: presence of a row = access. No permission columns.
  app.post(GRANT_PATTERNS.list, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);

    if (user.role === 'Receptionist' || user.role === 'Client') {
      await guards.audit(req, 'grant_denied', 'denied', { reason: 'role_forbidden' });
      return sendError(res, 403, 'forbidden', 'Insufficient role', { detail: { key: 'insufficientRole' } });
    }

    // The professional being granted names the tenant: a super-admin acts on whatever business owns
    // that professional; a tenant Admin/Professional only on their own.
    const scope = adminTenantScope(req, res);
    if (scope == null) return;

    const professionalUserId = req.body.professional_user_id;
    const granteeUserId = req.body.grantee_user_id;

    if (!professionalUserId || !granteeUserId) {
      return sendError(res, 400, 'invalid_request', 'professional_user_id and grantee_user_id are required', { detail: { key: 'grantMissingParticipants' } });
    }

    if (user.role === 'Professional' && Number(professionalUserId) !== user.id) {
      await guards.audit(req, 'grant_denied', 'denied', { reason: 'own_calendar_only' });
      return sendError(res, 403, 'forbidden', 'Professional may only manage their own calendar grants', { detail: { key: 'grantOwnCalendarOnly' } });
    }

    const pro = await findUser(pool, { id: professionalUserId, role: 'Professional', activeOnly: true });
    const businessId = resolveTargetTenant(scope, pro);
    if (businessId == null) {
      return sendError(res, 404, 'not_found', 'Professional not found in this business', { detail: { key: 'professionalNotFound' } });
    }

    // The grantee must live in the professional's tenant, so a grant never bridges two businesses.
    const grantee = await findUser(pool, { id: granteeUserId, activeOnly: true });
    if (!belongsToBusiness(grantee, businessId)) {
      return sendError(res, 422, 'invalid_request', 'Grantee not found in this business', { detail: { key: 'granteeNotFound' } });
    }
    if (!(GRANTABLE_STAFF_ROLES as readonly string[]).includes(grantee.role)) {
      return sendError(res, 422, 'invalid_request', 'Grantee must be staff (Receptionist or Professional)', { detail: { key: 'granteeMustBeStaff' } });
    }

    // A duplicate grant surfaces as a DbError(23505) → 409 via guardRoute's SQLSTATE mapping.
    const grant = await insertCalendarGrant(pool, professionalUserId, granteeUserId);
    if (!grant) return sendError(res, 500, 'internal_error', 'Internal server error');

    await guards.audit(req, 'grant_created', 'success', {
      entity_type: 'calendar_grants',
      entity_id: Number(grant.id),
      professional_user_id: professionalUserId,
      grantee_user_id: granteeUserId,
    }, { businessId });

    return sendData(res, grant, 201);
  }));

  // Revoke = delete the row; no soft-delete for grants.
  app.delete(GRANT_PATTERNS.detail, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);

    if (user.role === 'Receptionist' || user.role === 'Client') {
      await guards.audit(req, 'grant_denied', 'denied', { reason: 'role_forbidden' });
      return sendError(res, 403, 'forbidden', 'Insufficient role', { detail: { key: 'insufficientRole' } });
    }

    // The grant's owning professional names the tenant: a super-admin revokes in whatever business
    // owns it; a tenant Admin/Professional only in their own.
    const scope = adminTenantScope(req, res);
    if (scope == null) return;

    const grantId = Number(req.params.id);
    if (!Number.isInteger(grantId) || grantId <= 0) {
      return sendError(res, 400, 'invalid_request', 'Valid grant id is required', { detail: { key: 'invalidId' } });
    }

    const grant = await findGrantWithBusiness(pool, grantId);
    const businessId = resolveTargetTenant(scope, grant);
    if (businessId == null || grant == null) {
      return sendError(res, 404, 'not_found', 'Grant not found', { detail: { key: 'grantNotFound' } });
    }

    if (user.role === 'Professional' && Number(grant.professional_user_id) !== user.id) {
      return sendError(res, 403, 'forbidden', 'Professional may only revoke their own calendar grants', { detail: { key: 'grantOwnCalendarOnly' } });
    }

    await deleteCalendarGrant(pool, grantId);

    await guards.audit(req, 'grant_revoked', 'success', {
      entity_type: 'calendar_grants',
      entity_id: grantId,
      professional_user_id: grant.professional_user_id,
      grantee_user_id: grant.grantee_user_id,
    }, { businessId });

    return sendData(res, { id: grant.id, revoked: true });
  }));

  // Static path registered ahead of any /:id route so it can never be captured as a param.
  app.get(GRANT_PATTERNS.grantableStaff, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);

    // Only those who can create grants need this list: Admin (any) or a Professional (own calendar).
    if (user.role !== 'Admin' && user.role !== 'Professional') {
      return sendError(res, 403, 'forbidden', 'Insufficient role', { detail: { key: 'insufficientRole' } });
    }
    // Grants are tenant-bound; a super-admin (null business) has no business context.
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const staff = await listGrantableStaff(pool, businessId);

    return sendList(res, staff, { page: 1, limit: staff.length, total: staff.length });
  }));

  app.get(GRANT_PATTERNS.list, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);

    // Staff-internal data: clients have no business seeing who can manage which calendar.
    if (user.role === 'Client') {
      return sendError(res, 403, 'forbidden', 'Staff access required', { detail: { key: 'staffOnly' } });
    }
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const onlyProfessionalId =
      user.role === 'Professional'
        ? user.id
        : req.query.professional_user_id
          ? String(req.query.professional_user_id)
          : undefined;

    const grants = await listCalendarGrants(pool, {
      businessId,
      onlyProfessionalId,
    });

    await guards.audit(req, 'grant_listed', 'success', { count: grants.length });

    return sendList(res, grants, { page: 1, limit: grants.length, total: grants.length });
  }));
}
