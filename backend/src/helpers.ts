import type { TableKey, ColumnDef, TableStructure }  from '../../shared/src/types/types';
import      { structure } from '../../shared/src/ssot/structure';
import      { getPkFields } from '../../shared/src/utils/utils';
import type { Request as ExpressRequest, Response as ExpressResponse, NextFunction, RequestHandler } from 'express';
import { sendError } from './status_messages';
import { httpForDbError } from './db/errors';

// Express 4 does not catch rejected async handlers — one uncaught rejection kills the whole
// process. These wrappers are the crash net; structured error handling stays in the handlers.
function guardRoute(
  fn: (req: ExpressRequest, res: ExpressResponse) => Promise<ExpressResponse | void>,
): RequestHandler {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      const mapped = httpForDbError(error);
      if (mapped) {
        if (!res.headersSent) sendError(res, mapped.status, mapped.code, mapped.message);
        return;
      }
      console.error(`Unhandled error in ${req.method} ${req.path}:`, error);
      if (!res.headersSent) sendError(res, 500, 'internal_error', 'Internal server error');
    }
  };
}

// For async middleware. On rejection the request ends here (no next()): a failed
// auth/authz guard must never let the request fall through to the protected handler.
function guardMiddleware(
  fn: (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => Promise<ExpressResponse | void>,
): RequestHandler {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (error) {
      const mapped = httpForDbError(error);
      if (mapped) {
        if (!res.headersSent) sendError(res, mapped.status, mapped.code, mapped.message);
        return;
      }
      console.error(`Unhandled error in ${req.method} ${req.path}:`, error);
      if (!res.headersSent) sendError(res, 500, 'internal_error', 'Internal server error');
    }
  };
}

function getEntityName(table: TableKey): string {
  return String(structure.tables[table].uiName.en);
}

// Only SSOT-declared `filterable` columns may be used to build WHERE identifiers.
function getFilterableColumns(table: TableKey): Record<string, ColumnDef> {
  const columns = structure.tables[table].columns as Record<string, ColumnDef>;
  return Object.fromEntries(
    Object.entries(columns).filter(([, col]) => col.filterable === true),
  );
}

// Only SSOT-declared `sortable` columns (plus the PK, always orderable) may build ORDER BY.
function getSortableColumns(table: TableKey): string[] {
  const columns = structure.tables[table].columns as Record<string, ColumnDef>;
  const sortable = Object.entries(columns)
    .filter(([, col]) => col.sortable === true)
    .map(([name]) => name);
  return Array.from(new Set([...getPkFields(table), ...sortable]));
}

function getDerivableFields(tableName: TableKey): [string, ColumnDef][]{
  return Object.entries(structure.tables[tableName].columns).filter(([columnName, column]) => column.derivable);
}

function getNotDerivableFields(table: TableKey): string[]{
  const columns: [string, ColumnDef][] = Object.entries(structure.tables[table].columns as Record<string, ColumnDef>);
  const notDerivableEntries = columns.filter(([fieldName, columnDef]) => !columnDef.derivable);
  return notDerivableEntries.map(([fieldName, column]) => fieldName);
}

function getReferencedRelations(tableName: TableKey): TableKey[]{
  const refs = (structure.tables[tableName] as TableStructure).referencedTables;
  return (Array.isArray(refs) ? refs : []) as TableKey[];
}

function getRequiredFields(tableName: TableKey){
  const tableColumns: Record<string, ColumnDef> = structure.tables[tableName].columns;
  return Object.entries(tableColumns).filter(([fieldName, column]) => column.required);
}

// Returns columns that carry a referencesUserRole descriptor (i.e. the referenced auth.users
// row must have a specific role). Used by the generic write path instead of the removed
// composite-FK role constraint.
function getRoleCheckedColumns(tableName: TableKey): Array<{ column: string; role: string }> {
  const columns = structure.tables[tableName].columns as Record<string, ColumnDef>;
  return Object.entries(columns)
    .filter(([, def]) => def.referencesUserRole != null)
    .map(([column, def]) => ({ column, role: def.referencesUserRole! }));
}

export { guardRoute, guardMiddleware, getEntityName, getNotDerivableFields, getRequiredFields, getReferencedRelations, getDerivableFields, getFilterableColumns, getSortableColumns, getRoleCheckedColumns };