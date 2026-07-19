import { structure } from "../ssot/structure";
import type { TableKey } from "../ssot/derived";
import type {
  ColumnDef,
  TableStructure,
  CrudOp,
  CrudPolicy,
  SoftDeletePolicy,
  SchedulableCapability,
} from "../types/types";

// Each table literal `satisfies TableStructure`, which keeps its narrow literal type and hides
// the optional metadata fields. Read through the contract type to reach them generically.
export function tableOf(tableKey: TableKey): TableStructure {
  return structure.tables[tableKey] as TableStructure;
}

export function isTableKey(value: string): value is TableKey {
  return Object.prototype.hasOwnProperty.call(structure.tables, value);
}

export function getTableKeys(): TableKey[] {
  return Object.keys(structure.tables).filter(isTableKey);
}

export function getPkFields(tableKey: TableKey): string[] {
  const pk = tableOf(tableKey).pk;
  return Array.isArray(pk) ? pk : [pk];
}

export function getEntityName(tableKey: TableKey): string {
  return String(tableOf(tableKey).uiName.en);
}

// Only SSOT-declared `filterable` columns may be used to build WHERE identifiers.
export function getFilterableColumns(tableKey: TableKey): Record<string, ColumnDef> {
  return Object.fromEntries(
    Object.entries(tableOf(tableKey).columns).filter(([, col]) => col.filterable === true),
  );
}

// Only SSOT-declared `sortable` columns (plus the PK, always orderable) may build ORDER BY.
export function getSortableColumns(tableKey: TableKey): string[] {
  const sortable = Object.entries(tableOf(tableKey).columns)
    .filter(([, col]) => col.sortable === true)
    .map(([name]) => name);
  return Array.from(new Set([...getPkFields(tableKey), ...sortable]));
}

export function getDerivableFields(tableKey: TableKey): [string, ColumnDef][] {
  return Object.entries(tableOf(tableKey).columns).filter(([, column]) => column.derivable);
}

export function getNotDerivableFields(tableKey: TableKey): string[] {
  return Object.entries(tableOf(tableKey).columns)
    .filter(([, columnDef]) => !columnDef.derivable)
    .map(([fieldName]) => fieldName);
}

// Derivable columns are server-stamped and must never be accepted from the request body.
export function getServerDerivedFields(tableKey: TableKey): string[] {
  return getDerivableFields(tableKey).map(([name]) => name);
}

export function getReferencedRelations(tableKey: TableKey): TableKey[] {
  const refs = tableOf(tableKey).referencedTables;
  return Array.isArray(refs) ? refs.filter(isTableKey) : [];
}

// Columns that carry a referencesUserRole descriptor (i.e. the referenced auth.users row must
// have a specific role). Used by the generic write path instead of the removed composite-FK
// role constraint.
export function getRoleCheckedColumns(tableKey: TableKey): Array<{ column: string; role: string }> {
  return Object.entries(tableOf(tableKey).columns)
    .filter(([, def]) => def.referencesUserRole != null)
    .map(([column, def]) => ({ column, role: def.referencesUserRole! }));
}

// Column name every business-scoped table (and scope fragment) uses for its tenant owner.
export const BUSINESS_ID_COLUMN = 'business_id';

export function isBusinessScoped(tableKey: TableKey): boolean {
  return tableOf(tableKey).businessScoped === true;
}

export function isProtected(tableKey: TableKey): boolean {
  return tableOf(tableKey).protected === true;
}

export function getCrudPolicy(tableKey: TableKey): CrudPolicy | undefined {
  return tableOf(tableKey).crud;
}

export function getSoftDeletePolicy(tableKey: TableKey): SoftDeletePolicy | undefined {
  return tableOf(tableKey).softDelete;
}

export function getSchedulable(tableKey: TableKey): SchedulableCapability | undefined {
  return tableOf(tableKey).schedulable;
}

// Tables that store a schedulable owner's weekly/exception rows, derived from every schedulable
// capability's availability sources — so the set follows the descriptors instead of being named
// in the generic engine. Writes to these must pass the own/admin/grant schedule guard.
let ownerScheduledTables: ReadonlySet<string> | null = null;
export function isOwnerScheduledTable(tableKey: TableKey): boolean {
  if (ownerScheduledTables == null) {
    const tables = new Set<string>();
    for (const key of getTableKeys()) {
      const schedulable = getSchedulable(key);
      if (!schedulable) continue;
      tables.add(schedulable.availability.weeklySource);
      tables.add(schedulable.availability.exceptionSource);
    }
    ownerScheduledTables = tables;
  }
  return ownerScheduledTables.has(tableKey);
}

// The FK columns that identify a schedule row's owner, from every schedulable capability — so the
// generic engine's owner-reassignment guard follows the descriptors, not hardcoded column names.
export function getScheduleOwnerForeignKeys(): string[] {
  const fks = new Set<string>();
  for (const key of getTableKeys()) {
    const schedulable = getSchedulable(key);
    if (schedulable) fks.add(schedulable.ownerForeignKey);
  }
  return [...fks];
}

export function professionalOwnerGuardedOn(
  tableKey: TableKey,
  op: Extract<CrudOp, 'create' | 'update' | 'delete'>,
): boolean {
  const guard = tableOf(tableKey).professionalOwnerGuard;
  return !!guard && guard.ops.includes(op);
}

// Schedule-owner FKs split by owner kind, derived from the descriptors: the professional FK
// belongs to the schedulable whose rows are role-discriminated users (self/grant checks apply);
// the resource FK to the non-user schedulable (admin-managed rooms).
let scheduleOwnerFkByKind: { professional: string; resource: string } | null = null;
function getScheduleOwnerFkByKind(): { professional: string; resource: string } {
  if (scheduleOwnerFkByKind == null) {
    let professional = '';
    let resource = '';
    for (const key of getTableKeys()) {
      const schedulable = getSchedulable(key);
      if (!schedulable) continue;
      if (tableOf(key).roleDiscriminator) professional = schedulable.ownerForeignKey;
      else resource = schedulable.ownerForeignKey;
    }
    scheduleOwnerFkByKind = { professional, resource };
  }
  return scheduleOwnerFkByKind;
}

export function getProfessionalScheduleOwnerFk(): string {
  return getScheduleOwnerFkByKind().professional;
}

export function getResourceScheduleOwnerFk(): string {
  return getScheduleOwnerFkByKind().resource;
}

// Whether a table carries the resource owner column. Dual-owner schedule tables do; a
// professional-only owner-guarded table (professional_services) does not, so its owner row
// must be read without selecting a non-existent resource column.
export function ownerHasResourceColumn(tableKey: TableKey): boolean {
  return getResourceScheduleOwnerFk() in tableOf(tableKey).columns;
}

// Writes to a schedule-owned or professional-owner-guarded table must pass the async
// own/admin/grant schedule guard.
export function isScheduleGuarded(
  tableKey: TableKey,
  op: Extract<CrudOp, 'create' | 'update' | 'delete'>,
): boolean {
  return isOwnerScheduledTable(tableKey) || professionalOwnerGuardedOn(tableKey, op);
}
