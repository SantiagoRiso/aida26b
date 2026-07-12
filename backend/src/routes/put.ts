import express from 'express';
import { Pool } from 'pg';

import { getPkFields, isOwnerScheduledTable, getScheduleOwnerForeignKeys, professionalOwnerGuardedOn, ownerHasResourceColumn } from '../../../shared/src/utils/utils';

import {
  getEntityName,
  getNotDerivableFields,
  getServerDerivedFields,
} from '../helpers';

import { query as runQuery } from '../db/core';
import { DbError } from '../db/errors';
import { getScheduleOwnerRow } from '../db/scheduling';
import { buildUpdateStatement } from '../db/generic';
import { sendData, sendError } from '../status_messages';
import { assertCrudAllowed, assertOwnScheduleAllowed, assertRoleCheckedReferences } from './crud-policy';
import type { AuthUser } from '../auth';
import type { GenericRow } from '../../../shared/src/ssot/query-types';
import { tableOf } from '../../../shared/src/utils/utils';
import type { ColumnDef, ColumnValue, SqlParam, TableKey, TableRecordMap } from '../../../shared/src/types/types';
import { structure } from '../../../shared/src/ssot/structure';

import {
  validateFullObject,
  validateOnlyPk,
  sendErrorsIfInvalid,
} from '../validation/validate';

type AuthedRequest = express.Request & { user?: AuthUser };

// clients/professionals are logical views over auth.users. Even if the SSOT ever marks one
// of these editable, generic writes must never touch privileged auth columns — enforced here
// independent of the SSOT as defense-in-depth.
const AUTH_USERS_PROTECTED = new Set([
  'role',
  'password_hash',
  'password_salt',
  'is_active',
  'business_id',
  'must_change_password',
  'deleted_at',
  'deleted_by_user_id',
]);

export async function putHandler(
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

  const allowed = assertCrudAllowed(req.params.tableName, 'update', user);

  if (!allowed.ok) {
    return sendError(res, allowed.status, allowed.code, allowed.message);
  }

  const tableName = allowed.table;
  const entityName = getEntityName(tableName);
  const physicalTable = allowed.sqlTable !== tableName ? allowed.sqlTable : tableName;

  const serverDerived = new Set(getServerDerivedFields(tableName));
  const illegalFields = Object.keys(req.body as Partial<TableRecordMap[TableKey]>).filter(
    (k) => serverDerived.has(k),
  );
  if (illegalFields.length > 0) {
    return sendError(
      res,
      422,
      'server_derived_field',
      'These fields are set by the server and must not be supplied by the client',
      Object.fromEntries(illegalFields.map((f) => [f, 'must not be supplied'])),
    );
  }

  const validatedBody = validateFullObject(tableName, req.body);

  if (sendErrorsIfInvalid(res, validatedBody)) {
    return;
  }

  // The id arrives as a path segment (/api/:tableName/:id), not a query param — matches
  // how the frontend's crud.ts calls PUT and how generic entities only ever expose a single pk.
  const pkFields = getPkFields(tableName);
  const validatedPk = validateOnlyPk(tableName, { [pkFields[0]]: req.params.id });

  if (sendErrorsIfInvalid(res, validatedPk)) {
    return;
  }

  const pkValues = pkFields.map(
    (pkField) => validatedPk.data[pkField as keyof TableRecordMap[TableKey]]
  );

  // Own+Admin+granted enforcement for schedule tables — owner is read from the existing
  // row (authoritative), so a caller cannot edit a peer's row by omitting the owner in the body.
  if (isOwnerScheduledTable(tableName) || professionalOwnerGuardedOn(tableName, 'update')) {
    const existingRow = await getScheduleOwnerRow(pool, physicalTable, pkValues[0], ownerHasResourceColumn(tableName));
    if (!existingRow) {
      return sendError(res, 404, 'not_found', `${entityName} not found`);
    }

    // The owner is identity, not a mutable attribute: forbid reassigning a schedule row to another
    // owner through generic update. Without this, a caller authorized for the existing owner could
    // hand the row to a peer (the guard below only validates the existing owner). Owner FK columns
    // come from the schedulable descriptors, not hardcoded here.
    const body = validatedBody.data as Record<string, ColumnValue>;
    const existing = existingRow as Record<string, string | null>;
    for (const fk of getScheduleOwnerForeignKeys()) {
      const bodyOwner = body[fk] != null ? Number(body[fk]) : null;
      const rowOwner = existing[fk] != null ? Number(existing[fk]) : null;
      if (bodyOwner != null && bodyOwner !== rowOwner) {
        return sendError(res, 403, 'forbidden', 'The owner of a schedule row cannot be changed');
      }
    }

    const guard = await assertOwnScheduleAllowed(pool, user, existingRow);
    if (!guard.ok) {
      return sendError(res, guard.status, guard.code, guard.message);
    }
  }

  const refCheck = await assertRoleCheckedReferences(
    pool,
    tableName,
    validatedBody.data as Record<string, ColumnValue>,
    user,
  );
  if (!refCheck.ok) {
    return sendError(res, refCheck.status, refCheck.code, refCheck.message, refCheck.fields);
  }

  const columns = structure.tables[tableName].columns as Record<string, ColumnDef>;
  const fieldsToUpdate = getNotDerivableFields(tableName).filter(
    (fieldName) =>
      !pkFields.includes(fieldName) &&
      // Exclude columns marked editable:false — those are read-only through generic PUT.
      columns[fieldName]?.editable !== false &&
      !(physicalTable === 'auth.users' && AUTH_USERS_PROTECTED.has(fieldName)),
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
    (fieldName) => (validatedBody.data as Record<string, ColumnValue>)[fieldName]
  );

  const { text, values } = buildUpdateStatement(
    physicalTable,
    fieldsToUpdate,
    newValues,
    pkFields,
    pkValues,
    allowed,
  );

  try {
    const rows = await runQuery<GenericRow>(pool, text, values);

    if (rows.length === 0) {
      return sendError(res, 404, 'not_found', `${entityName} not found`);
    }

    return sendData(res, rows[0], 202);
  } catch (err) {
    if (err instanceof DbError && err.pgCode === '23505') {
      return sendError(res, 409, 'conflict', `${entityName} already exists`);
    }
    console.error(`Error updating ${entityName}:`, err);
    return sendError(res, 500, 'internal_error', 'Internal server error');
  }
}
