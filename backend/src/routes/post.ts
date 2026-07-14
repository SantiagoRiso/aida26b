import express from 'express';
import { Pool } from 'pg';

import { buildInsertStatement } from '../db/generic';

import { query as runQuery } from '../db/core';
import { sendData, sendError } from '../status_messages';
import { assertCrudAllowed, assertOwnScheduleAllowed, assertRoleCheckedReferences } from './crud-policy';
import type { OwnScheduleTarget } from './crud-policy';
import { requireUser, rejectServerDerivedFields } from './request-guards';
import {
  isBusinessScoped,
  isScheduleGuarded,
  getScheduleOwnerForeignKeys,
  getNotDerivableFields,
  BUSINESS_ID_COLUMN,
} from '../../../shared/src/utils/utils';
import type { ColumnValue } from '../../../shared/src/types/types';
import type { SqlParam } from '../db/core';
import type { GenericRow } from '../../../shared/src/ssot/query-types';

import {
  validateFullObject,
  sendErrorsIfInvalid,
} from '../validation/validate';

export async function postHandler(
  req: express.Request,
  res: express.Response,
  pool: Pool
) {
  const user = requireUser(req, res);
  if (!user) return;

  const allowed = assertCrudAllowed(req.params.tableName, 'create', user);

  if (!allowed.ok) {
    return sendError(res, allowed.status, allowed.code, allowed.message);
  }

  const tableName = allowed.table;
  const physicalTable = allowed.sqlTable;

  if (rejectServerDerivedFields(res, tableName, req.body)) {
    return;
  }

  const validated = validateFullObject(tableName, req.body);

  if (sendErrorsIfInvalid(res, validated)) {
    return;
  }

  const refCheck = await assertRoleCheckedReferences(
    pool,
    tableName,
    validated.data as Record<string, ColumnValue>,
    user,
  );
  if (!refCheck.ok) {
    return sendError(res, refCheck.status, refCheck.code, refCheck.message, refCheck.fields);
  }

  // Own+Admin+granted enforcement for schedule tables — the owner comes from the body on
  // create. Runs AFTER the generic role/reference checks so it refines (not preempts) their
  // 422 invalid_reference_role semantics; adds the own/grant 403/404 on top.
  if (isScheduleGuarded(tableName, 'create')) {
    const owner = req.body as OwnScheduleTarget | undefined;
    const guard = await assertOwnScheduleAllowed(
      pool,
      user,
      Object.fromEntries(getScheduleOwnerForeignKeys().map((fk) => [fk, owner?.[fk]])),
    );
    if (!guard.ok) {
      return sendError(res, guard.status, guard.code, guard.message);
    }
  }

  let notDerivableFields = getNotDerivableFields(tableName);

  const valuesToInsert: SqlParam[] = notDerivableFields.map(
    (fieldName) => (validated.data as Record<string, ColumnValue>)[fieldName],
  );

  // For businessScoped tables the business_id is not in the SSOT non-derivable fields
  // (it has `derivable` set), but we stamp it server-side from the session.
  if (isBusinessScoped(tableName) && user.business_id != null) {
    notDerivableFields = [...notDerivableFields, BUSINESS_ID_COLUMN];
    valuesToInsert.push(user.business_id);
  }

  const { text, values } = buildInsertStatement(physicalTable, notDerivableFields, valuesToInsert);

  // Constraint violations (unique, FK) propagate to guardRoute's central SQLSTATE mapping.
  const rows = await runQuery<GenericRow>(pool, text, values);
  return sendData(res, rows[0], 201);
}
