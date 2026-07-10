import type express from 'express';
import type { TableKey, SqlParam, ColumnDef } from '../../../shared/src/types/types';
import { getSoftDeletePolicy, getPkFields } from '../../../shared/src/utils/utils';
import { getFilterableColumns, getSortableColumns, getReferencedRelations, getDerivableFields } from '../helpers';
import { buildScopeConditions, type ScopeConditionsInput } from './scope';

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
  tableNameOrCTE: string,
  query: express.Request["query"],
  filterConfig: Record<string, ColumnDef>,
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

  for (const [key, rawValue] of Object.entries(query)) {
    if (!key.startsWith("filter_") || rawValue == null || rawValue === "") {
      continue;
    }

    const fieldName = key.slice(7);
    const config = filterConfig[fieldName];

    if (!config) {
      continue;
    }

    const vals = Array.isArray(rawValue) ? rawValue : [rawValue];

    for (const v of vals) {
      const strVal = String(v);

      if (!strVal) {
        continue;
      }

      const negated = strVal.startsWith("!");
      const actualVal = negated ? strVal.slice(1) : strVal;

      // A foreign-key column holds an opaque id, never free text — match it exactly.
      // Substring (ILIKE) matching an id would let `1` also match `10`, `21`, …
      if (config.foreignKey || config.options) {
        conditions.push(
          `"${fieldName}" ${negated ? "!=" : "="} $${paramIndex}`
        );
        values.push(actualVal);
        paramIndex++;
      } else if (config.type === "string") {
        conditions.push(
          `"${fieldName}"::text ${negated ? "NOT " : ""}ILIKE $${paramIndex}`
        );
        values.push(`%${actualVal}%`);
        paramIndex++;
      } else if (config.type === "number") {
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

  const requestedSort = Array.isArray(query.sort)
    ? query.sort[0]
    : query.sort;

  const requestedDir = Array.isArray(query.dir)
    ? query.dir[0]
    : query.dir;

  const sortDir = requestedDir === "desc" ? "DESC" : "ASC";

  const sortCol =
    typeof requestedSort === "string" && sortableColumns.includes(requestedSort)
      ? requestedSort
      : undefined;

  const orderColumns = sortCol
    ? [`"${sortCol}" ${sortDir}`]
    : defaultSortColumns
        .filter((column) => sortableColumns.includes(column))
        .map((column) => `"${column}" ${sortDir}`);

  const orderClause =
    orderColumns.length > 0 ? `ORDER BY ${orderColumns.join(", ")}` : "";

  const requestedPage = Array.isArray(query.page)
    ? query.page[0]
    : query.page;

  const page = Math.max(
    1,
    Math.min(parseInt(String(requestedPage || "1"), 10) || 1, 1000)
  );

  const requestedLimit = Array.isArray(query.limit)
    ? query.limit[0]
    : query.limit;

  const limit = Math.max(
    1,
    Math.min(parseInt(String(requestedLimit || "20"), 10) || 20, 500)
  );
  const offset = (page - 1) * limit;

  const fromClause = tableNameOrCTE.includes(" ")
    ? `FROM (${tableNameOrCTE}) AS base`
    : `FROM ${tableNameOrCTE}`;

  const dataQuery = `
    SELECT *
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
      const originTable = column.derivable?.originTable as TableKey;

      const expression = column.derivable?.sqlGenerationStatement.replace(
        /entityName/g,
        sqlAlias(originTable)
      );

      return `${expression} AS ${fieldName}`;
    })
  );

  return `SELECT ${selectFields.join(", ")}`;
}

function getBaseSelectQuery(tableName: TableKey, sqlTableOverride?: string): string {
  const referencedRelations = getReferencedRelations(tableName);
  const softDelete = softDeleteClause(tableName);
  const physicalTable = sqlTableOverride ?? tableName;

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
  query: express.Request["query"],
  allowed: ListScope,
): { dataQuery: string; dataValues: SqlParam[]; countQuery: string; countValues: SqlParam[]; page: number; limit: number } {
  const defaultSort = getPkFields(tableName);
  const { conditions: scopeConditions, values: scopeValues } = buildScopeConditions(allowed, 1);

  return buildListQueryInternal(
    getBaseSelectQuery(tableName, allowed.sqlTable !== tableName ? allowed.sqlTable : undefined),
    query,
    getFilterableColumns(tableName),
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
  const softDelete = softDeleteClause(tableName);
  const physicalTable = allowed.sqlTable !== tableName ? allowed.sqlTable : tableName;

  const { conditions: extraConditions, values: scopeValues } = buildScopeConditions(
    allowed,
    pkValues.length + 1,
  );
  const values: SqlParam[] = [...pkValues, ...scopeValues];
  const extraClause = extraConditions.length > 0 ? ` AND ${extraConditions.join(" AND ")}` : "";

  const text = `
    SELECT *
    FROM ${physicalTable}
    WHERE ${whereArguments}${softDelete ? ` AND ${softDelete}` : ""}${extraClause}
  `;

  return { text, values };
}

export function buildInsertStatement(
  physicalTable: string,
  fieldNames: string[],
  values: SqlParam[],
): { text: string; values: SqlParam[] } {
  const [fieldNamesTuple, parametersNumbersTuple] = formatTableColumnsForQuery(fieldNames);
  const text = `
    INSERT INTO ${physicalTable} ${fieldNamesTuple}
    VALUES ${parametersNumbersTuple}
    RETURNING *
  `;
  return { text, values };
}

export function buildUpdateStatement(
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
    RETURNING *
  `;

  return { text, values: [...newValues, ...pkValues, ...scopeParams] };
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
    const sets = [`${softDelete.deletedAtColumn} = now()`, `updated_at = now()`];
    const params: SqlParam[] = [];
    let nextParam = 1;

    if (softDelete.deletedByColumn) {
      sets.push(`${softDelete.deletedByColumn} = $${nextParam++}`);
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
      RETURNING *
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
    RETURNING *
  `;
  return { text, values: params };
}
