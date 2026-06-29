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
function tableOf(tableKey: TableKey): TableStructure {
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
