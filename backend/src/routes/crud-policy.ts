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
  if (isProtected(table)) return null;
  return getSsotCrudPolicy(table) ?? null;
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
      sqlTable: string;                // schema-qualified SQL table for use in queries
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
  // Admins without a business (e.g. super-admins) see all rows.
  if (user.business_id == null) {
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
  if (!isKnownTable(name) || isProtected(name)) {
    return { ok: false, status: 404, code: 'not_found', message: `Unknown entity '${name}'` };
  }

  const policy = getSsotCrudPolicy(name);
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

  // Ownership scoping: a Client is confined to their own row on every operation;
  // a Professional may read all peers (needed for scheduling) but may only modify
  // their own profile. Staff (Admin/Receptionist) are never owner-scoped.
  let ownerWhere: string | undefined;
  let ownerParams: unknown[] | undefined;
  if (meta.ownership) {
    const selfScoped =
      user.role === 'Client' ||
      (user.role === 'Professional' && (op === 'update' || op === 'delete'));
    if (selfScoped) {
      const ownerCol = (meta.ownership as OwnershipDescriptor).ownerColumn;
      ownerWhere = `"${ownerCol}" = ?`;
      ownerParams = [user.id];
    }
  }

  const disc = getRoleDiscriminatorFragment(name as TableKey);
  const discriminatorWhere = disc?.sql;
  const discriminatorParams = disc ? [disc.value] : undefined;

  const sqlTable = getSqlTable(name as TableKey);

  return {
    ok: true,
    table: name as TableKey,
    sqlTable,
    businessWhere,
    businessParams,
    ownerWhere,
    ownerParams,
    discriminatorWhere,
    discriminatorParams,
  };
}
