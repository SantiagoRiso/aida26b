import { structure } from '../../../shared/src/ssot/structure';
import { isProtected, getCrudPolicy as getSsotCrudPolicy } from '../../../shared/src/utils/utils';
import type { TableKey, CrudPolicy } from '../../../shared/src/types/types';

// Ordinary configuration entities declare a `crud` policy in the SSOT; protected/workflow
// entities expose none and are unreachable through these routes.

export type CrudOperation = 'create' | 'read' | 'update' | 'delete';

export function isKnownTable(name: string): name is TableKey {
  return Object.prototype.hasOwnProperty.call(structure.tables, name);
}

export function getCrudPolicy(table: TableKey): CrudPolicy | null {
  if (isProtected(table)) return null;
  return getSsotCrudPolicy(table) ?? null;
}

export type CrudCheck =
  | { ok: true; table: TableKey }
  | { ok: false; status: number; code: string; message: string };

// Unknown and protected entities both report not-found so the API never reveals which
// protected tables exist.
export function assertCrudAllowed(name: string, op: CrudOperation): CrudCheck {
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

  return { ok: true, table: name };
}
