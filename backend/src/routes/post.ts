import express from 'express';
import { Pool } from 'pg';

import {
  getEntityName,
  getNotDerivableFields,
  getServerDerivedFields,
} from '../helpers';

import { buildInsertStatement } from '../db/generic';

import { query as runQuery } from '../db/core';
import { DbError } from '../db/errors';
import { sendData, sendError } from '../status_messages';
import { assertCrudAllowed, assertOwnScheduleAllowed, assertRoleCheckedReferences } from './crud-policy';
import type { OwnScheduleTarget } from './crud-policy';
import type { AuthUser } from '../auth';
import { isBusinessScoped, isOwnerScheduledTable, professionalOwnerGuardedOn } from '../../../shared/src/utils/utils';
import type { ColumnValue, SqlParam, TableKey, TableRecordMap } from '../../../shared/src/types/types';
import type { GenericRow } from '../../../shared/src/ssot/query-types';

import {
  validateFullObject,
  sendErrorsIfInvalid,
} from '../validation/validate';

type AuthedRequest = express.Request & { user?: AuthUser };

export async function postHandler(
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

  const allowed = assertCrudAllowed(req.params.tableName, 'create', user);

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
  if (isOwnerScheduledTable(tableName) || professionalOwnerGuardedOn(tableName, 'create')) {
    const owner = req.body as OwnScheduleTarget | undefined;
    const guard = await assertOwnScheduleAllowed(pool, user, {
      professional_user_id: owner?.professional_user_id,
      resource_id: owner?.resource_id,
    });
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
    notDerivableFields = [...notDerivableFields, 'business_id'];
    valuesToInsert.push(user.business_id);
  }

  const { text, values } = buildInsertStatement(physicalTable, notDerivableFields, valuesToInsert);

  try {
    const rows = await runQuery<GenericRow>(pool, text, values);
    return sendData(res, rows[0], 201);
  } catch (err) {
    if (err instanceof DbError && err.pgCode === '23505') {
      return sendError(res, 409, 'conflict', `${entityName} already exists`);
    }
    console.error(`Error creating ${entityName}:`, err);
    return sendError(res, 500, 'internal_error', 'Internal server error');
  }
}
