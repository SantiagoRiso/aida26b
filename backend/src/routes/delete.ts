import express from 'express';
import { Pool } from 'pg';

import type { Response } from '../../../shared/src/types/types';
import { getPkFields, getSoftDeletePolicy } from '../../../shared/src/utils/utils';

import {
  getEntityName,
  tryQuery,
  columnNamesEqualsNumber,
} from '../helpers';

import { sendData, sendError } from '../status_messages';
import { assertCrudAllowed } from './crud-policy';

import {
  validateOnlyPk,
  sendErrorsIfInvalid,
} from '../validation/validate';

export async function deleteHandler(
  req: express.Request,
  res: express.Response,
  pool: Pool
) {
  const allowed = assertCrudAllowed(req.params.tableName, 'delete');

  if (!allowed.ok) {
    return sendError(res, allowed.status, allowed.code, allowed.message);
  }

  const tableName = allowed.table;
  const entityName = getEntityName(tableName);

  const pk = validateOnlyPk(tableName, req.query);

  if (sendErrorsIfInvalid(res, pk)) {
    return;
  }

  const pkFields = getPkFields(tableName);
  const pkValues = pkFields.map(
    (pkField) => (pk.data as Record<string, unknown>)[pkField]
  );

  const softDelete = getSoftDeletePolicy(tableName);

  let query: string;
  let params: unknown[];

  if (softDelete) {
    // Referenced core records are archived, never physically removed.
    const actorId = (req as { user?: { id?: number } }).user?.id ?? null;
    const sets = [`${softDelete.deletedAtColumn} = now()`, `updated_at = now()`];
    params = [];
    let nextParam = 1;

    if (softDelete.deletedByColumn) {
      sets.push(`${softDelete.deletedByColumn} = $${nextParam++}`);
      params.push(actorId);
    }

    const whereArguments = columnNamesEqualsNumber(pkFields, nextParam, ' AND ');
    params.push(...pkValues);

    query = `
      UPDATE ${tableName}
      SET ${sets.join(', ')}
      WHERE ${whereArguments} AND ${softDelete.deletedAtColumn} IS NULL
      RETURNING *
    `;
  } else {
    const whereArguments = columnNamesEqualsNumber(pkFields, 1, ' AND ');
    params = pkValues;
    query = `
      DELETE FROM ${tableName}
      WHERE ${whereArguments}
      RETURNING *
    `;
  }

  const queryResponse: Response = await tryQuery(pool, query, params);

  if (!queryResponse.success) {
    return sendError(res, 500, 'internal_error', queryResponse.message);
  }

  if (queryResponse.data?.rowCount === 0) {
    return sendError(res, 404, 'not_found', `${entityName} not found`);
  }

  return sendData(res, queryResponse.data?.rows?.[0], 200);
}
