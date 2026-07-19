import {
  isProtected,
  getCrudPolicy,
  tableOf,
  getProfessionalScheduleOwnerFk,
  getResourceScheduleOwnerFk,
  getRoleCheckedColumns,
  isTableKey,
} from '../../../shared/src/utils/utils';
import type { TableKey } from '../../../shared/src/ssot/derived';
import type { Queryable, SqlParam } from '../db/core';
import type { AuthUser } from '../auth';
import type { ColumnValue } from '../../../shared/src/types/types';
import { hasCalendarGrant } from '../db/grants';
import { getProfessionalOwner, getResourceOwner } from '../db/scheduling';
import { findRoleUserBusiness } from '../db/users';
import { buildBusinessScope, buildOwnerScope, buildGrantScope, roleDiscriminatorFragment } from '../db/scope';

// Ordinary configuration entities declare a `crud` policy in the SSOT; protected/workflow
// entities expose none and are unreachable through these routes.

export type CrudOperation = 'create' | 'read' | 'update' | 'delete';

export function getSqlTable(table: TableKey): string {
  return tableOf(table).sqlTable ?? table;
}

// Reads may target a secret-free view instead of the write table (see SSOT sqlReadTable).
export function getSqlReadTable(table: TableKey): string {
  return tableOf(table).sqlReadTable ?? getSqlTable(table);
}

export function isKnownTable(name: string): name is TableKey {
  return isTableKey(name);
}

export type CrudAccess =
  | { allowed: true }
  | { allowed: false; reason: 'hidden' | 'op_disabled' };

// Per-op reachability through generic CRUD — the single encoding of the protected-table rule.
// A protected table is unreachable unless it carves out an exception for THIS op (e.g. users:
// read-only, for the admin Usuarios screen); unreachability on a protected/undeclared table is
// 'hidden' (present as not-found, never reveal which protected tables exist), while a declared
// entity that simply doesn't expose the op is 'op_disabled'.
export function resolveCrudAccess(table: TableKey, op: CrudOperation): CrudAccess {
  const policy = getCrudPolicy(table);
  if (isProtected(table)) {
    return policy?.[op] ? { allowed: true } : { allowed: false, reason: 'hidden' };
  }
  if (!policy) return { allowed: false, reason: 'hidden' };
  if (!policy[op]) return { allowed: false, reason: 'op_disabled' };
  return { allowed: true };
}

export type CrudCheck =
  | {
      ok: true;
      table: TableKey;
      sqlTable: string;                // schema-qualified SQL table for writes
      sqlReadTable: string;            // schema-qualified source for reads (may be a secret-free view)
      businessWhere: string;
      businessParams: SqlParam[];
      ownerWhere?: string;
      ownerParams?: SqlParam[];
      grantWhere?: string;
      grantParams?: SqlParam[];
      discriminatorWhere?: string;     // role discriminator clause (renumbered by caller)
      discriminatorParams?: SqlParam[];
    }
  | { ok: false; status: number; code: string; message: string };

// Unknown and protected entities both report not-found so the API never reveals which
// protected tables exist.
export function assertCrudAllowed(name: string, op: CrudOperation, user: AuthUser): CrudCheck {
  if (!isKnownTable(name)) {
    return { ok: false, status: 404, code: 'not_found', message: `Unknown entity '${name}'` };
  }

  const access = resolveCrudAccess(name, op);
  if (!access.allowed) {
    if (access.reason === 'hidden') {
      return { ok: false, status: 404, code: 'not_found', message: `Unknown entity '${name}'` };
    }
    return {
      ok: false,
      status: 405,
      code: 'operation_not_allowed',
      message: `Operation '${op}' is not allowed for '${name}'`,
    };
  }

  const meta = tableOf(name);
  const required = meta.roleRequired?.[op] ?? [];
  if (required.length > 0 && !required.includes(user.role)) {
    return { ok: false, status: 403, code: 'forbidden', message: 'Insufficient role' };
  }

  const { businessWhere, businessParams } = buildBusinessScope(name, user);
  const { ownerWhere, ownerParams } = buildOwnerScope(name, user, op);
  const { grantWhere, grantParams } = buildGrantScope(name, user);

  const disc = roleDiscriminatorFragment(name);
  const discriminatorWhere = disc?.sql;
  const discriminatorParams = disc ? [disc.value] : undefined;

  const sqlTable = getSqlTable(name);
  const sqlReadTable = getSqlReadTable(name);

  return {
    ok: true,
    table: name,
    sqlTable,
    sqlReadTable,
    businessWhere,
    businessParams,
    ownerWhere,
    ownerParams,
    grantWhere,
    grantParams,
    discriminatorWhere,
    discriminatorParams,
  };
}

// Keyed by the schedule-owner FK columns the schedulable descriptors declare
// (professional/resource) — the descriptors, not this type, own the column names.
export type OwnScheduleTarget = Partial<Record<string, number | string | null>>;

export type OwnScheduleResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

// Finer-grained gate for schedule/exception/resource editing that the
// synchronous assertCrudAllowed cannot express (a granted-staff check needs a DB lookup).
// Own + Admin + granted: a Professional edits only their own; an Admin any owner in their
// business; a Receptionist/other staff only with a calendar_grant for that professional;
// resources are Admin-only for non-granted staff (no resource-grant column exists);
// a Client is always denied. Cross-business owners return 404 to hide existence.
export async function assertOwnScheduleAllowed(
  db: Queryable,
  user: AuthUser,
  target: OwnScheduleTarget,
): Promise<OwnScheduleResult> {
  if (user.role === 'Client') {
    return { ok: false, status: 403, code: 'forbidden', message: 'Clients cannot edit schedules' };
  }

  // A super-admin (Admin with no business) manages across tenants and skips the business match,
  // mirroring the generic write path. A non-admin without a business is anomalous → no_business.
  const isSuperAdmin = user.role === 'Admin' && user.business_id == null;
  if (user.business_id == null && !isSuperAdmin) {
    return { ok: false, status: 400, code: 'no_business', message: 'A business context is required to edit schedules' };
  }

  const professionalFk = getProfessionalScheduleOwnerFk();
  const resourceFk = getResourceScheduleOwnerFk();
  const professionalUserId = target[professionalFk] != null ? Number(target[professionalFk]) : null;
  const resourceId = target[resourceFk] != null ? Number(target[resourceFk]) : null;

  if (professionalUserId != null) {
    const row = await getProfessionalOwner(db, professionalUserId);
    const biz = row?.business_id;
    if (!row || biz == null || (!isSuperAdmin && Number(biz) !== user.business_id)) {
      return { ok: false, status: 404, code: 'not_found', message: 'Professional not found in this business' };
    }
  } else if (resourceId != null) {
    const row = await getResourceOwner(db, resourceId);
    const biz = row?.business_id;
    if (!row || biz == null || (!isSuperAdmin && Number(biz) !== user.business_id)) {
      return { ok: false, status: 404, code: 'not_found', message: 'Resource not found in this business' };
    }
  } else {
    return { ok: false, status: 422, code: 'invalid_request', message: `A ${professionalFk} or ${resourceFk} is required` };
  }

  if (user.role === 'Admin') return { ok: true };

  if (professionalUserId != null) {
    if (user.role === 'Professional') {
      return professionalUserId === user.id
        ? { ok: true }
        : { ok: false, status: 403, code: 'forbidden', message: 'A Professional may edit only their own schedule' };
    }
    // Receptionist / other staff need an explicit calendar grant for this professional.
    return (await hasCalendarGrant(db, professionalUserId, user.id))
      ? { ok: true }
      : { ok: false, status: 403, code: 'forbidden', message: 'A calendar grant for this professional is required' };
  }

  // Resource target: managed by Admin (handled above) + granted staff. The grant model is
  // per-professional only, so non-admin staff cannot manage resources.
  return { ok: false, status: 403, code: 'forbidden', message: 'Only an Admin may manage resource schedules' };
}

export type ReferenceCheckResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string; fields: Record<string, string> };

// Verify FK columns with a declared referencesUserRole point to an active user of the right role,
// and that every such reference shares one business so a row can never mix tenants (enforced even
// for super-admins). Replaces the removed composite-FK DB constraint; shared by create and update
// so the tenant-integrity rule lives in exactly one place.
export async function assertRoleCheckedReferences(
  db: Queryable,
  table: TableKey,
  data: Record<string, ColumnValue>,
  user: AuthUser,
): Promise<ReferenceCheckResult> {
  let referencedBusiness: number | undefined;
  for (const { column, role } of getRoleCheckedColumns(table)) {
    const refId = data[column];
    if (refId == null) continue;
    const check = await findRoleUserBusiness(db, refId, role);
    const refBusiness = check?.business_id;
    const invalidRef =
      !check ||
      refBusiness == null ||
      (user.business_id != null && Number(refBusiness) !== user.business_id) ||
      (referencedBusiness !== undefined && Number(refBusiness) !== referencedBusiness);
    if (invalidRef) {
      return {
        ok: false,
        status: 422,
        code: 'invalid_reference_role',
        message: `${column} must reference an active ${role} user`,
        fields: { [column]: `must be an active ${role}` },
      };
    }
    referencedBusiness = Number(refBusiness);
  }
  return { ok: true };
}
