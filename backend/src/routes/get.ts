import express from "express";
import { Pool } from "pg";

import { buildListStatement, buildRowStatement, type ListScope } from "../db/generic";

import { getPkFields, getEntityName } from "../../../shared/src/utils/utils";

import { query as runQuery } from "../db/core";

import {
  sendData,
  sendList,
  sendError,
} from "../status_messages";

import { assertCrudAllowed } from "./crud-policy";
import { requireUser } from "./request-guards";
import { parseListRequest } from "./list-request";
import { isFilterParam, isReservedListParam } from "../../../shared/src/ssot/list-protocol";

import type { TableKey, TableRecordMap } from "../../../shared/src/ssot/derived";
import type { SqlParam } from "../db/core";
import type { GenericRow } from "../../../shared/src/ssot/query-types";

import {
  validateOnlyPk,
  sendErrorsIfInvalid,
} from "../validation/validate";

export async function getHandler(
  req: express.Request,
  res: express.Response,
  pool: Pool
) {
  const user = requireUser(req, res);
  if (!user) return;

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
    (key) => isReservedListParam(key) || isFilterParam(key)
  );
}

async function getListOfTable(
  pool: Pool,
  res: express.Response,
  tableName: TableKey,
  query: express.Request["query"],
  allowed: ListScope,
) {
  const { dataQuery, dataValues, countQuery, countValues, page, limit } =
    buildListStatement(tableName, parseListRequest(query), allowed);

  const pageRows = await runQuery<GenericRow & { __total_count: string }>(pool, dataQuery, dataValues);
  if (pageRows.length === 0) {
    const countRows = await runQuery<{ count: string }>(pool, countQuery, countValues);
    return sendList(res, [], { page, limit, total: parseInt(countRows[0]?.count ?? "0", 10) });
  }

  const total = parseInt(pageRows[0].__total_count, 10);
  const dataRows = pageRows.map(({ __total_count: _, ...row }) => row);
  return sendList(res, dataRows, { page, limit, total });
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
