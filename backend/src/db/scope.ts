import { tableOf } from '../../../shared/src/utils/utils';
import type {
  TableKey,
  SqlParam,
  BusinessJoinDescriptor,
  OwnershipDescriptor,
  GrantScopeDescriptor,
  RoleDiscriminator,
} from '../../../shared/src/types/types';
import type { AuthUser } from '../auth';
import type { CrudOperation } from '../routes/crud-policy';

export type ScopeFragment = {
  businessWhere:  string;    // '' when Admin with no business or no scope needed
  businessParams: SqlParam[];
  ownerWhere?:    string;
  ownerParams?:   SqlParam[];
  grantWhere?:    string;
  grantParams?:   SqlParam[];
};

export type ScopeConditionsInput = {
  businessWhere: string;
  businessParams: SqlParam[];
  ownerWhere?: string;
  ownerParams?: SqlParam[];
  grantWhere?: string;
  grantParams?: SqlParam[];
  discriminatorWhere?: string;
  discriminatorParams?: SqlParam[];
};

export function reNumberFragment(template: string, startIndex: number): { sql: string; nextIndex: number } {
  let idx = startIndex;
  const sql = template.replace(/\?/g, () => `$${idx++}`);
  return { sql, nextIndex: idx };
}

// Renumbers and orders the scope fragments (discriminator → business → owner → grant) starting at
// `startIndex`, returning the conditions and their bound params. The single source for how a
// resolved scope becomes SQL — shared by every generic read/write path so the ordering and param
// numbering can never drift between them. Discriminator first so the DB can index on it.
export function buildScopeConditions(
  allowed: ScopeConditionsInput,
  startIndex: number,
): { conditions: string[]; values: SqlParam[]; nextIndex: number } {
  const conditions: string[] = [];
  const values: SqlParam[] = [];
  let idx = startIndex;

  const fragments: Array<[string | undefined, SqlParam[] | undefined]> = [
    [allowed.discriminatorWhere, allowed.discriminatorParams],
    [allowed.businessWhere, allowed.businessParams],
    [allowed.ownerWhere, allowed.ownerParams],
    [allowed.grantWhere, allowed.grantParams],
  ];

  for (const [where, params] of fragments) {
    if (!where) continue;
    const { sql, nextIndex } = reNumberFragment(where, idx);
    conditions.push(sql);
    values.push(...(params ?? []));
    idx = nextIndex;
  }

  return { conditions, values, nextIndex: idx };
}

export function buildBusinessScope(
  tableKey: TableKey,
  user: AuthUser,
): { businessWhere: string; businessParams: SqlParam[] } {
  // Only a super-admin (Admin with no business) sees every tenant's rows. The DB enforces
  // business_id IS NULL ⟹ role = 'Admin', but gate on role here too so an app-layer bug can
  // never widen scope to a non-admin who somehow lacks a business.
  if (user.business_id == null) {
    if (user.role !== 'Admin') {
      return { businessWhere: '1 = 0', businessParams: [] };
    }
    return { businessWhere: '', businessParams: [] };
  }

  const meta = tableOf(tableKey);

  if (meta.businessScoped) {
    return { businessWhere: '"business_id" = ?', businessParams: [user.business_id] };
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

export function roleDiscriminatorFragment(table: TableKey): { sql: string; value: string } | null {
  const meta = tableOf(table);
  const disc = (meta as { roleDiscriminator?: RoleDiscriminator }).roleDiscriminator;
  if (!disc) return null;
  return { sql: `"${disc.column}" = ?`, value: disc.value };
}

// Ownership scoping: self-restricts only the role (and, optionally, the specific ops) the
// descriptor targets — e.g. a Client is confined to their own row on every op for `clients`,
// but a Client reading `professionals` must NOT be scoped (that descriptor targets only a
// Professional editing their own profile; Clients need the full list to book).
export function buildOwnerScope(
  table: TableKey,
  user: AuthUser,
  op: CrudOperation,
): { ownerWhere?: string; ownerParams?: SqlParam[] } {
  const meta = tableOf(table);
  if (!meta.ownership) return {};
  const ownership = meta.ownership as OwnershipDescriptor;
  const opsMatch = !ownership.ops || ownership.ops.includes(op);
  if (user.role === ownership.role && opsMatch) {
    return { ownerWhere: `"${ownership.ownerColumn}" = ?`, ownerParams: [user.id] };
  }
  return {};
}

// Grant scoping: rows a grant table names for the caller — scoping, not a new error path, so
// ungranted single-row access surfaces as the generic empty/404. Composite-pk tables are not
// supported (a grant row names a single pk value).
export function buildGrantScope(
  table: TableKey,
  user: AuthUser,
): { grantWhere?: string; grantParams?: SqlParam[] } {
  const meta = tableOf(table);
  const gs = meta.grantScope as GrantScopeDescriptor | undefined;
  if (gs && user.role === gs.role && !Array.isArray(meta.pk)) {
    // Match the grant against the column that carries this table's professional owner. That is
    // the pk only when the pk IS the user id (professionals); on surrogate-pk owner tables
    // (schedule_blocks, …) it's the ownership column — matching against `id` there tests a row
    // id against a user id, never matches, and hides every granted row.
    const ownerColumn = (meta.ownership as OwnershipDescriptor | undefined)?.ownerColumn ?? meta.pk;
    return {
      grantWhere: `"${ownerColumn}" IN (SELECT "${gs.grantRowColumn}" FROM ${gs.grantTable} WHERE "${gs.granteeColumn}" = ?)`,
      grantParams: [user.id],
    };
  }
  return {};
}
