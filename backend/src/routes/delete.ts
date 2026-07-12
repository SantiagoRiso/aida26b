import express from 'express';
import { Pool } from 'pg';

import type { TableKey, TableRecordMap } from '../../../shared/src/types/types';
import { getPkFields, isOwnerScheduledTable, professionalOwnerGuardedOn, ownerHasResourceColumn } from '../../../shared/src/utils/utils';

import {
  getEntityName,
} from '../helpers';

import { buildDeleteStatement } from '../db/generic';

import { query as runQuery } from '../db/core';
import { getScheduleOwnerRow } from '../db/scheduling';
import { sendData, sendError } from '../status_messages';
import { assertCrudAllowed, assertOwnScheduleAllowed } from './crud-policy';
import type { AuthUser } from '../auth';
import type { GenericRow } from '../../../shared/src/ssot/query-types';

import {
  validateOnlyPk,
  sendErrorsIfInvalid,
} from '../validation/validate';

type AuthedRequest = express.Request & { user?: AuthUser };

export async function deleteHandler(
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

  const allowed = assertCrudAllowed(req.params.tableName, 'delete', user);

  if (!allowed.ok) {
    return sendError(res, allowed.status, allowed.code, allowed.message);
  }

  const tableName = allowed.table;
  const entityName = getEntityName(tableName);
  const physicalTable = allowed.sqlTable !== tableName ? allowed.sqlTable : tableName;

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
  if (isOwnerScheduledTable(tableName) || professionalOwnerGuardedOn(tableName, 'delete')) {
    const existingRow = await getScheduleOwnerRow(pool, physicalTable, pkValues[0], ownerHasResourceColumn(tableName));
    if (!existingRow) {
      return sendError(res, 404, 'not_found', `${entityName} not found`);
    }
    const guard = await assertOwnScheduleAllowed(pool, user, existingRow);
    if (!guard.ok) {
      return sendError(res, guard.status, guard.code, guard.message);
    }
  }

  const { text, values } = buildDeleteStatement(
    tableName,
    physicalTable,
    pkFields,
    pkValues,
    allowed,
    user?.id ?? null,
  );

  try {
    const rows = await runQuery<GenericRow>(pool, text, values);

    if (rows.length === 0) {
      return sendError(res, 404, 'not_found', `${entityName} not found`);
    }

    return sendData(res, rows[0], 200);
  } catch (err) {
    console.error(`Error deleting ${entityName}:`, err);
    return sendError(res, 500, 'internal_error', 'Internal server error');
  }
}
