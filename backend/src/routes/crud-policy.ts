import {
  isProtected,
  getCrudPolicy,
  tableOf,
  getProfessionalScheduleOwnerFk,
  getResourceScheduleOwnerFk,
  getRoleCheckedColumns,
  getForeignKeyColumns,
  getEntityName,
  isTableKey,
  BUSINESS_ID_COLUMN,
} from '../../../shared/src/utils/utils';
import type { TableKey } from '../../../shared/src/ssot/derived';
import { queryOne } from '../db/core';
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

// A referenced table is tenant-scoped when its own descriptor says how it reaches a business:
// directly (businessScoped) or through the parents its businessJoin names.
function tenantOwnerQuery(table: TableKey, valueField: string): { text: string; discriminator?: string } | null {
  const meta = tableOf(table);
  const from = getSqlReadTable(table);
  const disc = meta.roleDiscriminator;
  const discSql = disc ? ` AND t."${disc.column}" = $2` : '';
  const where = `WHERE t."${valueField}" = $1${discSql}`;

  if (meta.businessScoped) {
    return {
      text: `SELECT t."${BUSINESS_ID_COLUMN}" AS business_id FROM ${from} t ${where}`,
      discriminator: disc?.value,
    };
  }

  const paths = meta.businessJoin?.paths ?? [];
  if (paths.length === 0) return null;

  const joins = paths
    .map((p, i) => `LEFT JOIN ${p.parentTable} p${i} ON p${i}."${p.parentPk}" = t."${p.localFk}"`)
    .join(' ');
  const owner = paths.map((_, i) => `p${i}."${BUSINESS_ID_COLUMN}"`).join(', ');
  return {
    text: `SELECT COALESCE(${owner}) AS business_id FROM ${from} t ${joins} ${where}`,
    discriminator: disc?.value,
  };
}

// Every reference a written row carries must resolve inside one tenant — the caller's, and the same
// one for all of them, so a row can never mix businesses (enforced even for super-admins).
// Role-checked FKs additionally require an active user of the declared role; the rest are checked
// against whatever tenant their own descriptor derives, so a new FK is covered by declaring it.
// Replaces the removed composite-FK DB constraint; shared by create and update so the
// tenant-integrity rule lives in exactly one place.
export async function assertRoleCheckedReferences(
  db: Queryable,
  table: TableKey,
  data: Record<string, ColumnValue>,
  user: AuthUser,
): Promise<ReferenceCheckResult> {
  let referencedBusiness: number | undefined;

  const outOfTenant = (business: string | null | undefined): boolean =>
    business == null ||
    (user.business_id != null && Number(business) !== user.business_id) ||
    (referencedBusiness !== undefined && Number(business) !== referencedBusiness);

  for (const { column, role } of getRoleCheckedColumns(table)) {
    const refId = data[column];
    if (refId == null) continue;
    const check = await findRoleUserBusiness(db, refId, role);
    if (!check || outOfTenant(check.business_id)) {
      return {
        ok: false,
        status: 422,
        code: 'invalid_reference_role',
        message: `${column} must reference an active ${role} user`,
        fields: { [column]: `must be an active ${role}` },
      };
    }
    referencedBusiness = Number(check.business_id);
  }

  for (const { column, referencedTable, valueField } of getForeignKeyColumns(table)) {
    const refId = data[column];
    if (refId == null) continue;
    // A table that derives no business of its own (e.g. businesses) is not tenant-scoped: nothing
    // to compare, and the FK constraint still guards existence.
    const q = tenantOwnerQuery(referencedTable, valueField);
    if (!q) continue;
    const params: SqlParam[] = q.discriminator === undefined ? [refId] : [refId, q.discriminator];
    const check = await queryOne<{ business_id: string | null }>(db, q.text, params);
    if (!check || outOfTenant(check.business_id)) {
      // Unknown and out-of-tenant answer alike so a probe can't map another business's ids.
      const entity = getEntityName(referencedTable);
      return {
        ok: false,
        status: 404,
        code: 'not_found',
        message: `${entity} not found in this business`,
        fields: { [column]: 'not found in this business' },
      };
    }
    referencedBusiness = Number(check.business_id);
  }

  return { ok: true };
}
