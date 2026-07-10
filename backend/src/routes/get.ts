import express from "express";
import { Pool } from "pg";

import { getEntityName } from "../helpers";

import { buildListStatement, buildRowStatement, type ListScope } from "../db/generic";

import { getPkFields } from "../../../shared/src/utils/utils";

import { query as runQuery } from "../db/core";

import {
  sendData,
  sendList,
  sendError,
} from "../status_messages";

import { assertCrudAllowed } from "./crud-policy";
import type { AuthUser } from "../auth";

import type {
  TableKey,
  TableRecordMap,
  SqlParam,
} from "../../../shared/src/types/types";
import type { GenericRow } from "../../../shared/src/ssot/query-types";

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

async function getListOfTable(
  pool: Pool,
  res: express.Response,
  tableName: TableKey,
  query: express.Request["query"],
  allowed: ListScope,
) {
  try {
    const { dataQuery, dataValues, countQuery, countValues, page, limit } =
      buildListStatement(tableName, query, allowed);

    const [dataRows, countRows] = await Promise.all([
      runQuery<GenericRow>(pool, dataQuery, dataValues),
      runQuery<{ count: string }>(pool, countQuery, countValues),
    ]);

    const total = parseInt(countRows[0]?.count ?? "0", 10);

    return sendList(res, dataRows, { page, limit, total });
  } catch (error) {
    console.error(`Error fetching ${tableName}:`, error);
    return sendError(res, 500, "internal_error", "Internal server error");
  }
}

async function getRowOfTable(
  pool: Pool,
  res: express.Response,
  tableName: TableKey,
  query: express.Request["query"],
  entityName: string,
  allowed: ListScope,
) {
  const pk = validateOnlyPk(tableName, query);

  if (sendErrorsIfInvalid(res, pk)) {
    return;
  }

  const pkFields = getPkFields(tableName);

  const pkValues = pkFields.map(
    (pkField) => pk.data[pkField as keyof TableRecordMap[TableKey]]
  );

  const { text, values } = buildRowStatement(tableName, pkValues, allowed);
  const rows = await runQuery<GenericRow>(pool, text, values);

  if (rows.length === 0) {
    return sendError(res, 404, "not_found", `${entityName} not found`);
  }

  return sendData(res, rows[0], 200);
}
