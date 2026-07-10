import { Pool, PoolClient } from 'pg';
import { structure } from '../../../shared/src/ssot/structure';
import { isProtected, getCrudPolicy as getSsotCrudPolicy, tableOf } from '../../../shared/src/utils/utils';
import type {
  TableKey,
  CrudPolicy,
  RoleRequired,
  Role,
  SqlParam,
} from '../../../shared/src/types/types';
import type { AuthUser } from '../auth';
import type { ColumnValue } from '../../../shared/src/types/types';
import { hasCalendarGrant } from '../db/grants';
import { getProfessionalOwner, getResourceOwner } from '../db/scheduling';
import { findRoleUserBusiness } from '../db/users';
import { buildBusinessScope, buildOwnerScope, buildGrantScope, roleDiscriminatorFragment } from '../db/scope';
import { getRoleCheckedColumns } from '../helpers';

// Ordinary configuration entities declare a `crud` policy in the SSOT; protected/workflow
// entities expose none and are unreachable through these routes.

export type CrudOperation = 'create' | 'read' | 'update' | 'delete';

export function getSqlTable(table: TableKey): string {
  const meta = tableOf(table);
  return (meta as { sqlTable?: string }).sqlTable ?? table;
}

// Reads may target a secret-free view instead of the write table (see SSOT sqlReadTable).
export function getSqlReadTable(table: TableKey): string {
  const meta = tableOf(table);
  return (meta as { sqlReadTable?: string }).sqlReadTable ?? getSqlTable(table);
}

export function isKnownTable(name: string): name is TableKey {
  return Object.prototype.hasOwnProperty.call(structure.tables, name);
}

export function getCrudPolicy(table: TableKey): CrudPolicy | null {
  const policy = getSsotCrudPolicy(table) ?? null;
  if (!policy) return null;
  if (isProtected(table)) {
    // A protected table is unreachable through generic CRUD unless it carves out a narrow
    // op exception (e.g. users: read-only, for the admin Usuarios screen).
    const hasException = Object.values(policy).some(Boolean);
    return hasException ? policy : null;
  }
  return policy;
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

  const policy = getSsotCrudPolicy(name);

  // Protected entities are unreachable through generic CRUD by default. A table may carve out
  // a narrow exception for a single operation (e.g. users: read, for the admin Usuarios screen)
  // by declaring an explicit crud policy for just that op — every other op stays 404'd here,
  // same as a fully protected table.
  if (isProtected(name) && !(policy && policy[op])) {
    return { ok: false, status: 404, code: 'not_found', message: `Unknown entity '${name}'` };
  }

  if (!policy) {
    return { ok: false, status: 404, code: 'not_found', message: `Unknown entity '${name}'` };
  }

  if (!policy[op]) {
    return {
      ok: false,
      status: 405,
      code: 'operation_not_allowed',
      message: `Operation '${op}' is not allowed for '${name}'`,
    };
  }

  const meta = tableOf(name as TableKey);
  const required: Role[] = ((meta.roleRequired as RoleRequired | undefined)?.[op] ?? []) as Role[];
  if (required.length > 0 && !required.includes(user.role)) {
    return { ok: false, status: 403, code: 'forbidden', message: 'Insufficient role' };
  }

  const { businessWhere, businessParams } = buildBusinessScope(name as TableKey, user);
  const { ownerWhere, ownerParams } = buildOwnerScope(name as TableKey, user, op);
  const { grantWhere, grantParams } = buildGrantScope(name as TableKey, user);

  const disc = roleDiscriminatorFragment(name as TableKey);
  const discriminatorWhere = disc?.sql;
  const discriminatorParams = disc ? [disc.value] : undefined;

  const sqlTable = getSqlTable(name as TableKey);
  const sqlReadTable = getSqlReadTable(name as TableKey);

  return {
    ok: true,
    table: name as TableKey,
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

export type OwnScheduleTarget = {
  professional_user_id?: number | string | null;
  resource_id?: number | string | null;
};

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
  db: Pool | PoolClient,
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

  const professionalUserId = target.professional_user_id != null ? Number(target.professional_user_id) : null;
  const resourceId = target.resource_id != null ? Number(target.resource_id) : null;

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
    return { ok: false, status: 422, code: 'invalid_request', message: 'A professional_user_id or resource_id is required' };
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
  db: Pool | PoolClient,
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
