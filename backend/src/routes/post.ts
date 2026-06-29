import express from 'express';
import { Pool } from 'pg';

import {
  getEntityName,
  getNotDerivableFields,
  tryQuery,
  formatTableColumnsForQuery,
} from '../helpers';

import { sendData, sendError } from '../status_messages';
import { assertCrudAllowed } from './crud-policy';

import {
  validateFullObject,
  sendErrorsIfInvalid,
} from '../validation/validate';

export async function postHandler(
  req: express.Request,
  res: express.Response,
  pool: Pool
) {
  const allowed = assertCrudAllowed(req.params.tableName, 'create');

  if (!allowed.ok) {
    return sendError(res, allowed.status, allowed.code, allowed.message);
  }

  const tableName = allowed.table;
  const entityName = getEntityName(tableName);

  const validated = validateFullObject(tableName, req.body);

  if (sendErrorsIfInvalid(res, validated)) {
    return;
  }

  const notDerivableFields = getNotDerivableFields(tableName);

  const valuesToInsert = notDerivableFields.map(
    (fieldName) => (validated.data as Record<string, unknown>)[fieldName]
  );

  const [fieldNamesTuple, parametersNumbersTuple] =
    formatTableColumnsForQuery(notDerivableFields);

  const query = `
    INSERT INTO ${tableName} ${fieldNamesTuple}
    VALUES ${parametersNumbersTuple}
    RETURNING *
  `;

  const queryResponse = await tryQuery(pool, query, valuesToInsert);

  if (!queryResponse.success) {
    if (queryResponse.code === '23505') {
      return sendError(res, 409, 'conflict', `${entityName} already exists`);
    }

    return sendError(res, 500, 'internal_error', queryResponse.message);
  }

  return sendData(res, queryResponse.data.rows[0], 201);
}
