import type { TableKey, Response, ColumnDef, TableStructure, SqlParam }  from '../../shared/src/types/types';
import      { structure } from '../../shared/src/ssot/structure';
import      { getPkFields, getSoftDeletePolicy } from '../../shared/src/utils/utils';
import type { Pool }      from 'pg';
import type { Request as ExpressRequest, Response as ExpressResponse, NextFunction, RequestHandler } from 'express';
import { sendError } from './status_messages';

// Express 4 does not catch rejected async handlers — one uncaught rejection kills the whole
// process. These wrappers are the crash net; structured error handling stays in the handlers.
function guardRoute(
  fn: (req: ExpressRequest, res: ExpressResponse) => Promise<ExpressResponse | void>,
): RequestHandler {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
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
      console.error(`Unhandled error in ${req.method} ${req.path}:`, error);
      if (!res.headersSent) sendError(res, 500, 'internal_error', 'Internal server error');
    }
  };
}

function getEntityName(table: TableKey): string {
  return String(structure.tables[table].uiName.en);
}

function softDeleteClause(table: TableKey): string {
  const policy = getSoftDeletePolicy(table);
  return policy ? `"${policy.deletedAtColumn}" IS NULL` : '';
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

async function tryQuery(pool: Pool, queryStatement: string, queryArguments?: SqlParam[]): Promise<Response>{
  try {
    return {success: true , data: await pool.query(queryStatement, queryArguments), message: ''};
  } catch (error) {
    console.error(error);
    const e = error as { code?: string };
    const code = typeof e.code === 'string' ? e.code : undefined;
    return {success: false, data: error, message: 'Internal server error', code};
  }
}

function columnNamesEqualsNumber(columnsNames: string[], from: number = 1, separator: string = ','): string{
  let res: string = '';
  let i: number   = from;
  columnsNames.forEach(columnName => {
    res += `${columnName} = $${i++}` + separator;
  })
  return res.slice(0, -separator.length);
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

function formatTableColumnsForQuery(fieldsNames: string[], from: number = 1): string[]{
  let tupleWithReplaceParameters = '';
  for (let columnsCount = from; columnsCount <= fieldsNames.length; columnsCount++){
    tupleWithReplaceParameters += `$${columnsCount} `;
  }  
  tupleWithReplaceParameters = '(' + tupleWithReplaceParameters.split(' ').join(',').slice(0,-1) + ')';
  let tupleContent: string = '(' + fieldsNames.join(',') + ')';
  return [tupleContent, tupleWithReplaceParameters];
}

export { guardRoute, guardMiddleware, getEntityName, tryQuery, columnNamesEqualsNumber, getNotDerivableFields, getRequiredFields, formatTableColumnsForQuery, getReferencedRelations, getDerivableFields, getFilterableColumns, getSortableColumns, softDeleteClause, getRoleCheckedColumns };