import { structure } from "../ssot/structure";
import type {
  TableKey,
  TableStructure,
  CrudPolicy,
  SoftDeletePolicy,
  SchedulableCapability,
} from "../types/types";

// Each table literal `satisfies TableStructure`, which keeps its narrow literal type and hides
// the optional metadata fields. Read through the contract type to reach them generically.
export function tableOf(tableKey: TableKey): TableStructure {
  return structure.tables[tableKey] as TableStructure;
}

export function getPkFields(tableKey: TableKey): string[] {
  const pk = tableOf(tableKey).pk;
  return Array.isArray(pk) ? pk : [pk];
}

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
export function isOwnerScheduledTable(tableKey: string): boolean {
  if (ownerScheduledTables == null) {
    const tables = new Set<string>();
    for (const key of Object.keys(structure.tables) as TableKey[]) {
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
  for (const key of Object.keys(structure.tables) as TableKey[]) {
    const schedulable = getSchedulable(key);
    if (schedulable) fks.add(schedulable.ownerForeignKey);
  }
  return [...fks];
}

export function professionalOwnerGuardedOn(
  tableKey: string,
  op: 'create' | 'update' | 'delete',
): boolean {
  const guard = tableOf(tableKey as TableKey).professionalOwnerGuard;
  return !!guard && guard.ops.includes(op);
}

// Whether a table carries a resource_id owner column. Dual-owner schedule tables do; a
// professional-only owner-guarded table (professional_services) does not, so its owner row
// must be read without selecting a non-existent resource_id column.
export function ownerHasResourceColumn(tableKey: string): boolean {
  return 'resource_id' in tableOf(tableKey as TableKey).columns;
}
