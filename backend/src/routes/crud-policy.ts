import { Pool, PoolClient } from 'pg';
import { structure } from '../../../shared/src/ssot/structure';
import { isProtected, getCrudPolicy as getSsotCrudPolicy, tableOf } from '../../../shared/src/utils/utils';
import type {
  TableKey,
  CrudPolicy,
  RoleRequired,
  OwnershipDescriptor,
  BusinessJoinDescriptor,
  RoleDiscriminator,
  Role,
} from '../../../shared/src/types/types';
import type { AuthUser } from '../auth';

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

export function getRoleDiscriminatorFragment(table: TableKey): { sql: string; value: string } | null {
  const meta = tableOf(table);
  const disc = (meta as { roleDiscriminator?: RoleDiscriminator }).roleDiscriminator;
  if (!disc) return null;
  return { sql: `"${disc.column}" = ?`, value: disc.value };
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

export type ScopeFragment = {
  businessWhere:  string;    // '' when Admin with no business or no scope needed
  businessParams: unknown[];
  ownerWhere?:    string;
  ownerParams?:   unknown[];
};

export type CrudCheck =
  | {
      ok: true;
      table: TableKey;
      sqlTable: string;                // schema-qualified SQL table for writes
      sqlReadTable: string;            // schema-qualified source for reads (may be a secret-free view)
      businessWhere: string;
      businessParams: unknown[];
      ownerWhere?: string;
      ownerParams?: unknown[];
      discriminatorWhere?: string;     // role discriminator clause (renumbered by caller)
      discriminatorParams?: unknown[]; // single-element array with the discriminator value
    }
  | { ok: false; status: number; code: string; message: string };

export function reNumberFragment(template: string, startIndex: number): { sql: string; nextIndex: number } {
  let idx = startIndex;
  const sql = template.replace(/\?/g, () => `$${idx++}`);
  return { sql, nextIndex: idx };
}

export function buildBusinessScope(
  tableKey: TableKey,
  user: AuthUser,
): { businessWhere: string; businessParams: unknown[] } {
  // Only a super-admin (Admin with no business) sees every tenant's rows. The DB
  // enforces business_id IS NULL ⟹ role = 'Admin', but gate on role here too so an
  // app-layer bug can never widen scope to a non-admin who somehow lacks a business.
  if (user.business_id == null) {
    if (user.role !== 'Admin') {
      return { businessWhere: '1 = 0', businessParams: [] };
    }
    return { businessWhere: '', businessParams: [] };
  }

  const meta = tableOf(tableKey);

  if (meta.businessScoped) {
    return {
      businessWhere: '"business_id" = ?',
      businessParams: [user.business_id],
    };
  }

  const join = meta.businessJoin as BusinessJoinDescriptor | undefined;
  if (join && join.paths.length === 1) {
    const { parentTable, localFk, parentPk } = join.paths[0];
    return {
      businessWhere: `"${localFk}" IN (SELECT "${parentPk}" FROM ${parentTable} WHERE business_id = ?)`,
      businessParams: [user.business_id],
    };
  }

  if (join && join.paths.length >= 2) {
    // Dual-owner tables (schedules, schedule_exceptions): either owner may satisfy the filter.
    const parts = join.paths.map(({ parentTable, localFk, parentPk }) =>
      `"${localFk}" IN (SELECT "${parentPk}" FROM ${parentTable} WHERE business_id = ?)`,
    );
    return {
      businessWhere: `(${parts.join(' OR ')})`,
      businessParams: join.paths.map(() => user.business_id),
    };
  }

  return { businessWhere: '', businessParams: [] };
}

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

  // Ownership scoping: self-restricts only the role (and, optionally, the specific ops) the
  // descriptor targets — e.g. a Client is confined to their own row on every op for `clients`,
  // but a Client reading `professionals` must NOT be scoped: the descriptor there targets only
  // a Professional editing their own profile, and Clients need the full list to book.
  let ownerWhere: string | undefined;
  let ownerParams: unknown[] | undefined;
  if (meta.ownership) {
    const ownership = meta.ownership as OwnershipDescriptor;
    const opsMatch = !ownership.ops || ownership.ops.includes(op);
    if (user.role === ownership.role && opsMatch) {
      ownerWhere = `"${ownership.ownerColumn}" = ?`;
      ownerParams = [user.id];
    }
  }

  const disc = getRoleDiscriminatorFragment(name as TableKey);
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
// resources are Admin-only for non-granted staff (no resource-grant column exists in D1);
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
    const r = await db.query<{ business_id: string | null }>(
      `SELECT business_id FROM auth.users WHERE id = $1 AND role = 'Professional' AND is_active = true`,
      [professionalUserId],
    );
    const biz = r.rows[0]?.business_id;
    if (r.rows.length === 0 || biz == null || (!isSuperAdmin && Number(biz) !== user.business_id)) {
      return { ok: false, status: 404, code: 'not_found', message: 'Professional not found in this business' };
    }
  } else if (resourceId != null) {
    const r = await db.query<{ business_id: string | null }>(
      `SELECT business_id FROM resources WHERE id = $1 AND deleted_at IS NULL`,
      [resourceId],
    );
    const biz = r.rows[0]?.business_id;
    if (r.rows.length === 0 || biz == null || (!isSuperAdmin && Number(biz) !== user.business_id)) {
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
    const grant = await db.query(
      `SELECT 1 FROM calendar_grants WHERE professional_user_id = $1 AND grantee_user_id = $2`,
      [professionalUserId, user.id],
    );
    return grant.rows.length > 0
      ? { ok: true }
      : { ok: false, status: 403, code: 'forbidden', message: 'A calendar grant for this professional is required' };
  }

  // Resource target: managed by Admin (handled above) + granted staff. The grant model is
  // per-professional only, so non-admin staff cannot manage resources in D1.
  return { ok: false, status: 403, code: 'forbidden', message: 'Only an Admin may manage resource schedules' };
}
