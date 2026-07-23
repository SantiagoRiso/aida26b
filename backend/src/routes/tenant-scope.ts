import type express from 'express';
import type { Pool } from 'pg';
import { authenticatedUser } from '../session';
import { requireBusinessContext } from './business-context';
import { getBusinessSettings } from '../db/businesses';
import { sendError } from '../status_messages';
import type { UserAdminScope } from '../db/users';

// Super-admin = an Admin with no business of its own (the cross-tenant role). Only Admins can be
// tenantless, so a null business uniquely identifies it once the route's role gate has run.
function isSuperAdmin(user: { role: string; business_id: number | null }): boolean {
  return user.role === 'Admin' && user.business_id == null;
}

// Which tenant(s) an admin write may reach, reusing the user-admin union: a super-admin reaches
// every tenant (the target row names which one); everyone else is confined to their session's
// business and is refused without one. Null means a response was already sent.
export function adminTenantScope(
  req: express.Request,
  res: express.Response,
): UserAdminScope | null {
  if (isSuperAdmin(authenticatedUser(req))) return { kind: 'all' };
  const businessId = requireBusinessContext(req, res);
  if (businessId == null) return null;
  return { kind: 'tenant', businessId };
}

// The tenant a scoped write lands on, derived from the target row: a super-admin acts on whatever
// tenant the row belongs to; a tenant admin only on a row in its own business. An unknown,
// tenantless, or cross-tenant row all resolve to null so the caller answers 404 without leaking
// existence — mirroring belongsToBusiness and the generic write path's super-admin skip.
export function resolveTargetTenant(
  scope: UserAdminScope,
  row: { business_id: string | number | null } | null | undefined,
): number | null {
  const biz = row?.business_id;
  if (row == null || biz == null) return null;
  if (scope.kind === 'all') return Number(biz);
  return Number(biz) === scope.businessId ? scope.businessId : null;
}

// The tenant a create lands on, which has no target row to read: a super-admin names it explicitly
// (target_business_id) and it must exist; every other caller has it stamped from session and naming
// one is refused, so no row can be minted outside the caller's business. Null means a response was
// already sent.
export async function resolveCreationTenant(
  pool: Pool,
  req: express.Request,
  res: express.Response,
): Promise<number | null> {
  const requested = req.body.target_business_id;

  if (!isSuperAdmin(authenticatedUser(req))) {
    if (requested !== undefined) {
      sendError(res, 400, 'invalid_request', 'You cannot act in another business', { detail: { key: 'targetBusinessNotAllowed' } });
      return null;
    }
    return requireBusinessContext(req, res);
  }

  const businessId = Number(requested);
  if (!Number.isInteger(businessId) || businessId <= 0) {
    sendError(res, 400, 'invalid_request', 'A target business is required', { detail: { key: 'targetBusinessRequired' } });
    return null;
  }

  // An unknown tenant would otherwise surface only when a later FK fires.
  if (!(await getBusinessSettings(pool, businessId))) {
    sendError(res, 400, 'invalid_request', 'Unknown business', { detail: { key: 'targetBusinessNotFound' } });
    return null;
  }

  return businessId;
}
