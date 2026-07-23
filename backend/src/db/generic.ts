import type { ColumnDef, SoftDeletePolicy } from '../../../shared/src/types/types';
import type { TableKey } from '../../../shared/src/ssot/derived';
import type { ListRequestSpec } from '../../../shared/src/ssot/list-protocol';
import {
  filterColumnKind,
  parseFilterSet,
  LIST_MAX_FILTER_SET,
} from '../../../shared/src/ssot/list-protocol';
import type { SqlParam } from './core';
import {
  getSoftDeletePolicy,
  getPkFields,
  getFilterableColumns,
  getSortableColumns,
  getReferencedRelations,
  getDerivableFields,
  tableOf,
  isTableKey,
} from '../../../shared/src/utils/utils';
import { buildScopeConditions, type ScopeConditionsInput } from './scope';
import { dateBoundConditions } from './date-bounds';
import { DATE_RE } from '../time';

// A filter value that can't be read as its column's type narrows to nothing. Widening back to the
// whole table would hand the caller a page that silently ignores the constraint they asked for.
const NEVER_MATCHES = '1 = 0';

// `%` and `_` are LIKE wildcards: unescaped, a search for either matches every row.
const LIKE_ESCAPE = '\\';

function escapeLikeValue(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `${LIKE_ESCAPE}${char}`);
}

function isDateFilterValue(value: string): boolean {
  return DATE_RE.test(value) || !Number.isNaN(Date.parse(value));
}

export function softDeleteClause(table: TableKey): string {
  const policy = getSoftDeletePolicy(table);
  return policy ? `"${policy.deletedAtColumn}" IS NULL` : '';
}

export function columnNamesEqualsNumber(columnsNames: string[], from = 1, separator = ','): string {
  let res = '';
  let i = from;
  columnsNames.forEach((columnName) => {
    res += `${columnName} = $${i++}` + separator;
  });
  return res.slice(0, -separator.length);
}

export function formatTableColumnsForQuery(fieldsNames: string[], from = 1): string[] {
  let tupleWithReplaceParameters = '';
  for (let columnsCount = from; columnsCount <= fieldsNames.length; columnsCount++) {
    tupleWithReplaceParameters += `$${columnsCount} `;
  }
  tupleWithReplaceParameters = '(' + tupleWithReplaceParameters.split(' ').join(',').slice(0, -1) + ')';
  const tupleContent = '(' + fieldsNames.join(',') + ')';
  return [tupleContent, tupleWithReplaceParameters];
}

export type ListScope = ScopeConditionsInput & { sqlTable: string };

function buildListQueryInternal(
  baseQuery: string,
  projection: string,
  spec: ListRequestSpec,
  filterConfig: Record<string, ColumnDef>,
  pkFields: string[],
  defaultSort: string | string[],
  sortableColumns: string[],
  // Pre-built scope conditions (with $N starting at 1) and their values.
  // paramIndex begins AFTER these to avoid numbering collisions.
  scopeConditions: string[] = [],
  scopeValues: SqlParam[] = [],
) {
  const conditions: string[] = [...scopeConditions];
  const values: SqlParam[] = [...scopeValues];
  let paramIndex = scopeValues.length + 1;

  for (const { field: fieldName, values: filterValues } of spec.filters) {
    const config = filterConfig[fieldName];

    // Fields the descriptor doesn't declare filterable are silently ignored.
    if (!config) {
      continue;
    }

    const kind = filterColumnKind(config, pkFields.includes(fieldName));

    for (const { negated, value: actualVal } of filterValues) {
      // An identity column holds an opaque token, never free text — match it exactly. Substring
      // (ILIKE) matching an id would let `1` also match `10`, `21`, … A set names alternatives;
      // negating one excludes every member, so `!` still reads as the complement of the match.
      if (kind === "identity") {
        const members = parseFilterSet(actualVal);

        if (members.length === 0 || members.length > LIST_MAX_FILTER_SET) {
          conditions.push(NEVER_MATCHES);
          continue;
        }

        if (members.length === 1) {
          conditions.push(`"${fieldName}" ${negated ? "!=" : "="} $${paramIndex}`);
          values.push(members[0]);
          paramIndex++;
        } else {
          const placeholders = members.map((_, offset) => `$${paramIndex + offset}`);
          conditions.push(
            `"${fieldName}" ${negated ? "NOT IN" : "IN"} (${placeholders.join(", ")})`
          );
          values.push(...members);
          paramIndex += members.length;
        }
      } else if (kind === "text") {
        conditions.push(
          `"${fieldName}"::text ${negated ? "NOT " : ""}ILIKE $${paramIndex} ESCAPE '${LIKE_ESCAPE}'`
        );
        values.push(`%${escapeLikeValue(actualVal)}%`);
        paramIndex++;
      } else if (kind === "boolean") {
        const flag =
          actualVal === "true" ? true : actualVal === "false" ? false : null;

        if (flag === null) {
          conditions.push(NEVER_MATCHES);
          continue;
        }

        // IS [NOT] DISTINCT FROM, so on a nullable flag the excluded set is the exact
        // complement of the included one and no row falls out of both.
        conditions.push(
          `"${fieldName}" IS ${negated ? "" : "NOT "}DISTINCT FROM $${paramIndex}::boolean`
        );
        values.push(flag);
        paramIndex++;
      } else if (kind === "date") {
        // Same `min,max` grammar as a numeric range; a bare value names a single calendar day.
        const commaIdx = actualVal.indexOf(",");
        const fromPart = commaIdx >= 0 ? actualVal.slice(0, commaIdx) : actualVal;
        const toPart = commaIdx >= 0 ? actualVal.slice(commaIdx + 1) : actualVal;

        if (fromPart === "" && toPart === "") {
          continue;
        }

        if (
          (fromPart !== "" && !isDateFilterValue(fromPart)) ||
          (toPart !== "" && !isDateFilterValue(toPart))
        ) {
          conditions.push(NEVER_MATCHES);
          continue;
        }

        // Day bounds resolve in the business timezone through the shared helper, so a list
        // filter and a bespoke date-range route can't disagree on where a day starts.
        const bounds = dateBoundConditions(
          `"${fieldName}"`,
          {
            from: fromPart !== "" ? fromPart : undefined,
            to: toPart !== "" ? toPart : undefined,
          },
          paramIndex
        );

        const range = bounds.conditions.join(" AND ");
        conditions.push(negated ? `NOT (${range})` : `(${range})`);
        values.push(...bounds.params);
        paramIndex = bounds.nextIndex;
      } else if (kind === "number") {
        const commaIdx = actualVal.indexOf(",");

        if (commaIdx >= 0) {
          const minPart = actualVal.slice(0, commaIdx);
          const maxPart = actualVal.slice(commaIdx + 1);
          const hasMin = minPart !== "";
          const hasMax = maxPart !== "";

          if (hasMin && hasMax) {
            const nMin = parseFloat(minPart);
            const nMax = parseFloat(maxPart);

            if (isNaN(nMin) || isNaN(nMax)) {
              conditions.push(NEVER_MATCHES);
              continue;
            }

            if (negated) {
              conditions.push(
                `("${fieldName}" < $${paramIndex} OR "${fieldName}" > $${paramIndex + 1})`
              );
            } else {
              conditions.push(
                `"${fieldName}" >= $${paramIndex} AND "${fieldName}" <= $${paramIndex + 1}`
              );
            }

            values.push(nMin, nMax);
            paramIndex += 2;
          } else if (hasMin) {
            const n = parseFloat(minPart);

            if (isNaN(n)) {
              conditions.push(NEVER_MATCHES);
              continue;
            }

            conditions.push(
              `"${fieldName}" ${negated ? "<" : ">="} $${paramIndex}`
            );
            values.push(n);
            paramIndex++;
          } else if (hasMax) {
            const n = parseFloat(maxPart);

            if (isNaN(n)) {
              conditions.push(NEVER_MATCHES);
              continue;
            }

            conditions.push(
              `"${fieldName}" ${negated ? ">" : "<="} $${paramIndex}`
            );
            values.push(n);
            paramIndex++;
          }
        } else {
          const n = parseFloat(actualVal);

          if (isNaN(n)) {
            conditions.push(NEVER_MATCHES);
            continue;
          }

          conditions.push(
            `"${fieldName}" ${negated ? "<" : ">="} $${paramIndex}`
          );
          values.push(n);
          paramIndex++;
        }
      }
    }
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const defaultSortColumns = Array.isArray(defaultSort)
    ? defaultSort
    : [defaultSort];

  const sortDir = spec.dir === "desc" ? "DESC" : "ASC";

  const sortCol =
    spec.sort !== undefined && sortableColumns.includes(spec.sort)
      ? spec.sort
      : undefined;

  // The pk always closes the sort. A chosen column may tie across rows, and two LIMIT/OFFSET
  // queries over a non-deterministic order can hand the same row twice and skip another.
  const tiebreakers = defaultSortColumns.filter(
    (column) => sortableColumns.includes(column) && column !== sortCol
  );

  const orderColumns = (sortCol ? [sortCol, ...tiebreakers] : tiebreakers).map(
    (column) => `"${column}" ${sortDir}`
  );

  const orderClause =
    orderColumns.length > 0 ? `ORDER BY ${orderColumns.join(", ")}` : "";

  const { page, limit } = spec;
  const offset = (page - 1) * limit;

  const fromClause = `FROM (${baseQuery}) AS base`;

  const dataQuery = `
    SELECT ${projection}, COUNT(*) OVER()::text AS "__total_count"
    ${fromClause}
    ${whereClause}
    ${orderClause}
    LIMIT $${paramIndex}
    OFFSET $${paramIndex + 1}
  `;

  const dataValues = [...values, limit, offset];

  const countQuery = `
    SELECT COUNT(*)
    ${fromClause}
    ${whereClause}
  `;

  return {
    dataQuery,
    dataValues,
    countQuery,
    countValues: [...values],
    page,
    limit,
  };
}

// The stable table key is a valid SQL identifier; the localized UI name is not
// (it may contain spaces) and must never be an alias.
function sqlAlias(table: TableKey): string {
  return table;
}

function getJoinsStatements(
  queryTable: TableKey,
  referencedRelations: TableKey[]
): string {
  let joinsStatement = "";
  const entityName = sqlAlias(queryTable);

  referencedRelations.forEach((tableName) => {
    const referencedEntityName = sqlAlias(tableName);

    joinsStatement += ` JOIN ${tableName} ${referencedEntityName} ON `;

    const pkFields = getPkFields(tableName);

    const pkFieldsEqualityStatements = pkFields.map(
      (pk) => `${entityName}.${pk} = ${referencedEntityName}.${pk}`
    );

    joinsStatement += pkFieldsEqualityStatements.join(" AND ");
  });

  return joinsStatement;
}

function getSelectStatement(tableName: TableKey): string {
  const entityName = sqlAlias(tableName);
  const selectFields = [`${entityName}.*`];

  const derivedFields: [string, ColumnDef][] = getDerivableFields(tableName);

  selectFields.push(
    ...derivedFields.map(([fieldName, column]) => {
      const originTable = column.derivable?.originTable;
      if (!originTable || !isTableKey(originTable)) {
        throw new Error(`Invalid derivable origin table for ${tableName}.${fieldName}`);
      }

      const expression = column.derivable?.sqlGenerationStatement.replace(
        /entityName/g,
        sqlAlias(originTable)
      );

      return `${expression} AS ${fieldName}`;
    })
  );

  return `SELECT ${selectFields.join(", ")}`;
}

// Every projection — read and write alike — is the descriptor's declared column list. The physical
// source carries more than the descriptor declares (auth.users behind clients/professionals holds
// credentials; the tenant and role columns the scope predicates need are undeclared), so a wildcard
// hands the caller columns the contract never promised.
function declaredColumnList(tableName: TableKey, alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  return Object.keys(tableOf(tableName).columns)
    .map((column) => `${prefix}"${column}"`)
    .join(", ");
}

// The single read source (columns, derivable expressions, referenced-table JOINs, soft-delete
// filter). Both the list and single-row paths select from this, so their row shape can never
// diverge. It stays a wildcard so the outer query can still scope, filter and sort on columns the
// descriptor doesn't declare; the narrowing to declared columns happens in that outer projection.
function getBaseSelectQuery(tableName: TableKey, physicalTable: string): string {
  const referencedRelations = getReferencedRelations(tableName);
  const softDelete = softDeleteClause(tableName);

  if (referencedRelations.length > 0) {
    const alias = sqlAlias(tableName);
    const where = softDelete ? `WHERE ${alias}.${softDelete}` : "";
    return `
      ${getSelectStatement(tableName)}
      FROM ${physicalTable} ${alias}
      ${getJoinsStatements(tableName, referencedRelations)}
      ${where}
    `;
  }

  return softDelete
    ? `SELECT * FROM ${physicalTable} WHERE ${softDelete}`
    : `SELECT * FROM ${physicalTable}`;
}

export function buildListStatement(
  tableName: TableKey,
  spec: ListRequestSpec,
  allowed: ListScope,
): { dataQuery: string; dataValues: SqlParam[]; countQuery: string; countValues: SqlParam[]; page: number; limit: number } {
  const pkFields = getPkFields(tableName);
  const defaultSort = pkFields;
  const { conditions: scopeConditions, values: scopeValues } = buildScopeConditions(allowed, 1);

  return buildListQueryInternal(
    getBaseSelectQuery(tableName, allowed.sqlTable),
    declaredColumnList(tableName, "base"),
    spec,
    getFilterableColumns(tableName),
    pkFields,
    defaultSort,
    getSortableColumns(tableName),
    scopeConditions,
    scopeValues,
  );
}

export function buildRowStatement(
  tableName: TableKey,
  pkValues: SqlParam[],
  allowed: ListScope,
): { text: string; values: SqlParam[] } {
  const pkFields = getPkFields(tableName);
  const whereArguments = columnNamesEqualsNumber(pkFields, 1, " AND ");

  const { conditions: extraConditions, values: scopeValues } = buildScopeConditions(
    allowed,
    pkValues.length + 1,
  );
  const values: SqlParam[] = [...pkValues, ...scopeValues];
  const extraClause = extraConditions.length > 0 ? ` AND ${extraConditions.join(" AND ")}` : "";

  // Same projection as the list path (soft-delete filter included in the base).
  const baseQuery = getBaseSelectQuery(tableName, allowed.sqlTable);

  const text = `
    SELECT ${declaredColumnList(tableName, "base")}
    FROM (${baseQuery}) AS base
    WHERE ${whereArguments}${extraClause}
  `;

  return { text, values };
}

// Writes target `sqlTable`, which for a logical entity is the raw table behind its secret-free
// `sqlReadTable` view (clients/professionals → auth.users, which carries the password columns).
export function writeReturningClause(tableName: TableKey): string {
  return `RETURNING ${declaredColumnList(tableName)}`;
}

export function buildInsertStatement(
  physicalTable: string,
  fieldNames: string[],
  values: SqlParam[],
  tableName: TableKey,
): { text: string; values: SqlParam[] } {
  const [fieldNamesTuple, parametersNumbersTuple] = formatTableColumnsForQuery(fieldNames);
  const text = `
    INSERT INTO ${physicalTable} ${fieldNamesTuple}
    VALUES ${parametersNumbersTuple}
    ${writeReturningClause(tableName)}
  `;
  return { text, values };
}

export function buildUpdateStatement(
  tableName: TableKey,
  physicalTable: string,
  fieldsToUpdate: string[],
  newValues: SqlParam[],
  pkFields: string[],
  pkValues: SqlParam[],
  allowed: ScopeConditionsInput,
): { text: string; values: SqlParam[] } {
  const setArgumentsString = columnNamesEqualsNumber(fieldsToUpdate, 1, ", ");

  const pkStart = fieldsToUpdate.length + 1;
  const whereArgumentsString = columnNamesEqualsNumber(pkFields, pkStart, " AND ");

  const scopeStart = pkStart + pkFields.length;
  const { conditions: scopeConditions, values: scopeParams } = buildScopeConditions(allowed, scopeStart);
  const scopeClause = scopeConditions.length > 0 ? ` AND ${scopeConditions.join(" AND ")}` : "";

  const text = `
    UPDATE ${physicalTable}
    SET ${setArgumentsString}
    WHERE ${whereArgumentsString}${scopeClause}
    ${writeReturningClause(tableName)}
  `;

  return { text, values: [...newValues, ...pkValues, ...scopeParams] };
}

// What archiving a row does to its columns, in one place: the generic engine compiles it from the
// descriptor, and db/users.ts reuses it so the bespoke admin deactivation can't mean something
// different by "archived". `actorParam` is the $N carrying the acting user's id.
export function softDeleteAssignments(policy: SoftDeletePolicy, actorParam: number): string[] {
  const sets = [`${policy.deletedAtColumn} = now()`, `updated_at = now()`];
  if (policy.activeColumn) sets.push(`${policy.activeColumn} = false`);
  if (policy.deletedByColumn) sets.push(`${policy.deletedByColumn} = $${actorParam}`);
  return sets;
}

export function buildDeleteStatement(
  tableName: TableKey,
  physicalTable: string,
  pkFields: string[],
  pkValues: SqlParam[],
  allowed: ScopeConditionsInput,
  actorId: number | null,
): { text: string; values: SqlParam[] } {
  const softDelete = getSoftDeletePolicy(tableName);

  if (softDelete) {
    // Referenced core records are archived, never physically removed.
    const sets = softDeleteAssignments(softDelete, 1);
    const params: SqlParam[] = [];
    let nextParam = 1;

    if (softDelete.deletedByColumn) {
      nextParam++;
      params.push(actorId);
    }

    const whereArguments = columnNamesEqualsNumber(pkFields, nextParam, " AND ");
    params.push(...pkValues);
    nextParam += pkFields.length;

    // AND scope into WHERE so out-of-scope rows yield rowCount 0 → 404.
    const { conditions: scopeConditions, values: scopeValues } = buildScopeConditions(allowed, nextParam);
    params.push(...scopeValues);
    const scopeClause = scopeConditions.length > 0 ? ` AND ${scopeConditions.join(" AND ")}` : "";

    const text = `
      UPDATE ${physicalTable}
      SET ${sets.join(", ")}
      WHERE ${whereArguments} AND ${softDelete.deletedAtColumn} IS NULL${scopeClause}
      ${writeReturningClause(tableName)}
    `;
    return { text, values: params };
  }

  const whereArguments = columnNamesEqualsNumber(pkFields, 1, " AND ");
  const params: SqlParam[] = [...pkValues];

  const { conditions: scopeConditions, values: scopeValues } = buildScopeConditions(allowed, pkValues.length + 1);
  params.push(...scopeValues);
  const scopeClause = scopeConditions.length > 0 ? ` AND ${scopeConditions.join(" AND ")}` : "";

  const text = `
    DELETE FROM ${physicalTable}
    WHERE ${whereArguments}${scopeClause}
    ${writeReturningClause(tableName)}
  `;
  return { text, values: params };
}
