import express from 'express';
import { Pool } from 'pg';

import type { Response } from '../../../shared/src/types/types';
import { getPkFields } from '../../../shared/src/utils/utils';

import {
  getEntityName,
  getNotDerivableFields,
  tryQuery,
  columnNamesEqualsNumber,
} from '../helpers';

import { sendData, sendError } from '../status_messages';
import { assertCrudAllowed } from './crud-policy';

import {
  validateFullObject,
  validateOnlyPk,
  sendErrorsIfInvalid,
} from '../validation/validate';

export async function putHandler(
  req: express.Request,
  res: express.Response,
  pool: Pool
) {
  const allowed = assertCrudAllowed(req.params.tableName, 'update');

  if (!allowed.ok) {
    return sendError(res, allowed.status, allowed.code, allowed.message);
  }

  const tableName = allowed.table;
  const entityName = getEntityName(tableName);

  const validatedBody = validateFullObject(tableName, req.body);

  if (sendErrorsIfInvalid(res, validatedBody)) {
    return;
  }

  const validatedPk = validateOnlyPk(tableName, req.query);

  if (sendErrorsIfInvalid(res, validatedPk)) {
    return;
  }

  const pkFields = getPkFields(tableName);

  const pkValues = pkFields.map(
    (pkField) => (validatedPk.data as Record<string, unknown>)[pkField]
  );

  const fieldsToUpdate = getNotDerivableFields(tableName).filter(
    (fieldName) => !pkFields.includes(fieldName)
  );

  if (fieldsToUpdate.length === 0) {
    return sendError(
      res,
      400,
      'no_editable_fields',
      `No editable fields found for ${entityName}`
    );
  }

  const newValues = fieldsToUpdate.map(
    (fieldName) => (validatedBody.data as Record<string, unknown>)[fieldName]
  );

  const setArgumentsString = columnNamesEqualsNumber(
    fieldsToUpdate,
    1,
    ', '
  );

  const whereArgumentsString = columnNamesEqualsNumber(
    pkFields,
    fieldsToUpdate.length + 1,
    ' AND '
  );

  const query = `
    UPDATE ${tableName}
    SET ${setArgumentsString}
    WHERE ${whereArgumentsString}
    RETURNING *
  `;

  const result: Response = await tryQuery(pool, query, [
    ...newValues,
    ...pkValues,
  ]);

  if (!result.success) {
    if (result.code === '23505') {
      return sendError(res, 409, 'conflict', `${entityName} already exists`);
    }

    return sendError(res, 500, 'internal_error', result.message);
  }

  if (result.data?.rowCount === 0) {
    return sendError(res, 404, 'not_found', `${entityName} not found`);
  }

  return sendData(res, result.data.rows[0], 202);
}
