import express from 'express';
import { Pool } from 'pg';

import type { TableKey, TableRecordMap } from '../../../shared/src/ssot/derived';
import { getPkFields, isScheduleGuarded, ownerHasResourceColumn, getEntityName } from '../../../shared/src/utils/utils';

import { buildDeleteStatement } from '../db/generic';

import { query as runQuery } from '../db/core';
import { getScheduleOwnerRow } from '../db/scheduling';
import { sendData, sendError } from '../status_messages';
import { assertCrudAllowed, assertOwnScheduleAllowed } from './crud-policy';
import { requireUser } from './request-guards';
import { auditGenericWrite, auditGenericDenied } from './crud-audit';
import type { GenericRow } from '../../../shared/src/ssot/query-types';

import {
  validateOnlyPk,
  sendErrorsIfInvalid,
} from '../validation/validate';

export async function deleteHandler(
  req: express.Request,
  res: express.Response,
  pool: Pool
) {
  const user = requireUser(req, res);
  if (!user) return;

  const allowed = assertCrudAllowed(req.params.tableName, 'delete', user);

  if (!allowed.ok) {
    await auditGenericDenied(pool, req, allowed);
    return sendError(res, allowed.status, allowed.code, allowed.message);
  }

  const tableName = allowed.table;
  const entityName = getEntityName(tableName);
  const physicalTable = allowed.sqlTable;

  // The id arrives as a path segment (/api/:tableName/:id), not a query param — matches
  // how the frontend's crud.ts calls DELETE and how generic entities only ever expose a single pk.
  const pkFields = getPkFields(tableName);
  const pk = validateOnlyPk(tableName, { [pkFields[0]]: req.params.id });

  if (sendErrorsIfInvalid(res, pk)) {
    return;
  }

  const pkValues = pkFields.map(
    (pkField) => pk.data[pkField as keyof TableRecordMap[TableKey]]
  );

  // Own+Admin+granted enforcement for schedule tables — owner read from the existing row.
  if (isScheduleGuarded(tableName, 'delete')) {
    const existingRow = await getScheduleOwnerRow(pool, physicalTable, pkValues[0], ownerHasResourceColumn(tableName));
    if (!existingRow) {
      return sendError(res, 404, 'not_found', `${entityName} not found`);
    }
    const guard = await assertOwnScheduleAllowed(pool, user, existingRow);
    if (!guard.ok) {
      await auditGenericDenied(pool, req, guard);
      return sendError(res, guard.status, guard.code, guard.message);
    }
  }

  const { text, values } = buildDeleteStatement(
    tableName,
    physicalTable,
    pkFields,
    pkValues,
    allowed,
    user.id,
  );

  // Constraint violations (unique, FK) propagate to guardRoute's central SQLSTATE mapping.
  const rows = await runQuery<GenericRow>(pool, text, values);

  if (rows.length === 0) {
    return sendError(res, 404, 'not_found', `${entityName} not found`);
  }

  await auditGenericWrite(pool, req, tableName, 'delete', rows[0]);

  return sendData(res, rows[0], 200);
}
