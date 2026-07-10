import express from "express";
import { Pool } from "pg";

import {
  getEntityName,
  getDerivableFields,
  getReferencedRelations,
  getFilterableColumns,
  getSortableColumns,
  softDeleteClause,
  tryQuery,
  columnNamesEqualsNumber,
} from "../helpers";

import { getPkFields } from "../../../shared/src/utils/utils";

import {
  sendData,
  sendList,
  sendError,
} from "../status_messages";

import { assertCrudAllowed, buildScopeConditions, getSqlTable } from "./crud-policy";
import type { AuthUser } from "../auth";

import type {
  TableKey,
  TableRecordMap,
  ColumnDef,
  SqlParam,
  Response as QueryResponse,
} from "../../../shared/src/types/types";

import {
  validateOnlyPk,
  sendErrorsIfInvalid,
} from "../validation/validate";

type AuthedRequest = express.Request & { user?: AuthUser };

export async function getHandler(
  req: express.Request,
  res: express.Response,
  pool: Pool
) {
  const user = (req as AuthedRequest).user;

  // Fail closed: no authenticated user means no authority. A missing req.user must
  // never resolve to a privileged identity.
  if (!user) {
    return sendError(res, 401, 'unauthorized', 'Authentication required');
  }

  const allowed = assertCrudAllowed(req.params.tableName, "read", user);

  if (!allowed.ok) {
    return sendError(res, allowed.status, allowed.code, allowed.message);
  }

  const tableName = allowed.table;
  const entityName = getEntityName(tableName);

  // Reads use the (possibly secret-free) read source; writes elsewhere use allowed.sqlTable.
  if (isListRequest(req.query)) {
    return getListOfTable(pool, res, tableName, req.query, {
      sqlTable: allowed.sqlReadTable,
      businessWhere: allowed.businessWhere,
      businessParams: allowed.businessParams,
      ownerWhere: allowed.ownerWhere,
      ownerParams: allowed.ownerParams,
      grantWhere: allowed.grantWhere,
      grantParams: allowed.grantParams,
      discriminatorWhere: allowed.discriminatorWhere,
      discriminatorParams: allowed.discriminatorParams,
    });
  }

  return getRowOfTable(pool, res, tableName, req.query, entityName, {
    sqlTable: allowed.sqlReadTable,
    businessWhere: allowed.businessWhere,
    businessParams: allowed.businessParams,
    ownerWhere: allowed.ownerWhere,
    ownerParams: allowed.ownerParams,
    grantWhere: allowed.grantWhere,
    grantParams: allowed.grantParams,
    discriminatorWhere: allowed.discriminatorWhere,
    discriminatorParams: allowed.discriminatorParams,
  });
}

export function buildListQuery(
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

function isListRequest(query: express.Request["query"]): boolean {
  const queryKeys = Object.keys(query);

  if (queryKeys.length === 0) {
    return true;
  }

  return queryKeys.every(
    (key) =>
      key === "page" ||
      key === "sort" ||
      key === "dir" ||
      key === "limit" ||
      key.startsWith("filter_")
  );
}

// SQL alias for a table in generated queries. The stable table key is a valid SQL
// identifier; the localized UI name is not (it may contain spaces) and must never be an alias.
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

function getListFilterConfig(tableName: TableKey): Record<string, ColumnDef> {
  return getFilterableColumns(tableName);
}

async function getListOfTable(
  pool: Pool,
  res: express.Response,
  tableName: TableKey,
  query: express.Request["query"],
  allowed: {
    sqlTable: string;
    businessWhere: string;
    businessParams: SqlParam[];
    ownerWhere?: string;
    ownerParams?: SqlParam[];
    grantWhere?: string;
    grantParams?: SqlParam[];
    discriminatorWhere?: string;
    discriminatorParams?: SqlParam[];
  },
) {
  try {
    const defaultSort = getPkFields(tableName);

    const { conditions: scopeConditions, values: scopeValues } = buildScopeConditions(allowed, 1);

    const { dataQuery, dataValues, countQuery, countValues, page, limit } =
      buildListQuery(
        getBaseSelectQuery(tableName, allowed.sqlTable !== tableName ? allowed.sqlTable : undefined),
        query,
        getListFilterConfig(tableName),
        defaultSort,
        getSortableColumns(tableName),
        scopeConditions,
        scopeValues,
      );

    const [dataResult, countResult] = await Promise.all([
      pool.query(dataQuery, dataValues),
      pool.query(countQuery, countValues),
    ]);

    const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

    return sendList(res, dataResult.rows, { page, limit, total });
  } catch (error) {
    console.error(`Error fetching ${tableName}:`, error);
    return sendError(res, 500, "internal_error", "Internal server error");
  }
}

async function getRowByPKs(
  pool: Pool,
  tableName: TableKey,
  pkValues: SqlParam[],
  allowed: {
    sqlTable: string;
    businessWhere: string;
    businessParams: SqlParam[];
    ownerWhere?: string;
    ownerParams?: SqlParam[];
    grantWhere?: string;
    grantParams?: SqlParam[];
    discriminatorWhere?: string;
    discriminatorParams?: SqlParam[];
  },
) {
  const pkFields = getPkFields(tableName);
  const whereArguments = columnNamesEqualsNumber(pkFields, 1, " AND ");
  const softDelete = softDeleteClause(tableName);
  const physicalTable = allowed.sqlTable !== tableName ? allowed.sqlTable : tableName;

  const { conditions: extraConditions, values: scopeValues } = buildScopeConditions(
    allowed,
    pkValues.length + 1,
  );
  const allParams: SqlParam[] = [...pkValues, ...scopeValues];

  const extraClause = extraConditions.length > 0 ? ` AND ${extraConditions.join(" AND ")}` : "";

  const queryStatement = `
    SELECT *
    FROM ${physicalTable}
    WHERE ${whereArguments}${softDelete ? ` AND ${softDelete}` : ""}${extraClause}
  `;

  return tryQuery(pool, queryStatement, allParams);
}

async function getRowOfTable(
  pool: Pool,
  res: express.Response,
  tableName: TableKey,
  query: express.Request["query"],
  entityName: string,
  allowed: {
    sqlTable: string;
    businessWhere: string;
    businessParams: SqlParam[];
    ownerWhere?: string;
    ownerParams?: SqlParam[];
    grantWhere?: string;
    grantParams?: SqlParam[];
    discriminatorWhere?: string;
    discriminatorParams?: SqlParam[];
  },
) {
  const pk = validateOnlyPk(tableName, query);

  if (sendErrorsIfInvalid(res, pk)) {
    return;
  }

  const pkFields = getPkFields(tableName);

  const pkValues = pkFields.map(
    (pkField) => pk.data[pkField as keyof TableRecordMap[TableKey]]
  );

  const responseQuery: QueryResponse = await getRowByPKs(
    pool,
    tableName,
    pkValues,
    allowed,
  );

  if (!responseQuery.success) {
    return sendError(res, 500, "internal_error", responseQuery.message);
  }

  if (responseQuery.data.rowCount === 0) {
    return sendError(res, 404, "not_found", `${entityName} not found`);
  }

  return sendData(res, responseQuery.data.rows[0], 200);
}
