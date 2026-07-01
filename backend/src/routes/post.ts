import express from 'express';
import { Pool } from 'pg';

import {
  getEntityName,
  getNotDerivableFields,
  tryQuery,
  formatTableColumnsForQuery,
  getRoleCheckedColumns,
} from '../helpers';

import { sendData, sendError } from '../status_messages';
import { assertCrudAllowed } from './crud-policy';
import type { AuthUser } from '../auth';
import { isBusinessScoped } from '../../../shared/src/utils/utils';

import {
  validateFullObject,
  sendErrorsIfInvalid,
} from '../validation/validate';

type AuthedRequest = express.Request & { user?: AuthUser };

// Fields whose values are always derived server-side and must never come from the request body.
const SERVER_DERIVED = new Set(['business_id']);

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

  // Reject body fields that the server derives from the session.
  const illegalFields = Object.keys(req.body as Record<string, unknown>).filter(
    (k) => SERVER_DERIVED.has(k),
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

  // Verify that FK columns with a declared referencesUserRole point to a user with the correct role.
  // This replaces the removed composite-FK DB constraint.
  const roleChecks = getRoleCheckedColumns(tableName);
  for (const { column, role } of roleChecks) {
    const refId = (validated.data as Record<string, unknown>)[column];
    if (refId == null) continue;
    // Scope the FK target to the caller's business so a row cannot reference a user
    // in another tenant (a null business_id is a super-admin and skips the restriction).
    const check = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM auth.users
         WHERE id = $1 AND role = $2 AND deleted_at IS NULL
           AND ($3::bigint IS NULL OR business_id = $3::bigint)
       ) AS exists`,
      [refId, role, user.business_id]
    );
    if (!check.rows[0].exists) {
      return sendError(
        res, 422, 'invalid_reference_role',
        `${column} must reference an active ${role} user`,
        { [column]: `must be an active ${role}` }
      );
    }
  }

  let notDerivableFields = getNotDerivableFields(tableName);

  const valuesToInsert: unknown[] = notDerivableFields.map(
    (fieldName) => (validated.data as Record<string, unknown>)[fieldName],
  );

  // For businessScoped tables the business_id is not in the SSOT non-derivable fields
  // (it has `derivable` set), but we stamp it server-side from the session.
  if (isBusinessScoped(tableName) && user.business_id != null) {
    notDerivableFields = [...notDerivableFields, 'business_id'];
    valuesToInsert.push(user.business_id);
  }

  const [fieldNamesTuple, parametersNumbersTuple] =
    formatTableColumnsForQuery(notDerivableFields);

  const query = `
    INSERT INTO ${physicalTable} ${fieldNamesTuple}
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
