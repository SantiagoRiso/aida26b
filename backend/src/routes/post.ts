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
import { assertCrudAllowed, assertOwnScheduleAllowed } from './crud-policy';
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

  // Verify FK columns with a declared referencesUserRole point to an active user of the
  // right role, and derive the row's tenant from that user rather than the caller. Every
  // role-checked reference must share one business, so no row can mix tenants — enforced
  // even for super-admins, who would otherwise bypass the business restriction entirely.
  // This replaces the removed composite-FK DB constraint.
  const roleChecks = getRoleCheckedColumns(tableName);
  let referencedBusiness: number | undefined;
  for (const { column, role } of roleChecks) {
    const refId = (validated.data as Record<string, unknown>)[column];
    if (refId == null) continue;
    const check = await pool.query<{ business_id: string | null }>(
      `SELECT business_id FROM auth.users
       WHERE id = $1 AND role = $2 AND deleted_at IS NULL`,
      [refId, role]
    );
    const refBusiness = check.rows[0]?.business_id;
    const invalidRef =
      check.rows.length === 0 ||
      refBusiness == null ||
      (user.business_id != null && Number(refBusiness) !== user.business_id) ||
      (referencedBusiness !== undefined && Number(refBusiness) !== referencedBusiness);
    if (invalidRef) {
      return sendError(
        res, 422, 'invalid_reference_role',
        `${column} must reference an active ${role} user`,
        { [column]: `must be an active ${role}` }
      );
    }
    referencedBusiness = Number(refBusiness);
  }

  // D-16: own+Admin+granted enforcement for schedule tables — the owner comes from the body on
  // create. Runs AFTER the generic role/reference checks so it refines (not preempts) their
  // 422 invalid_reference_role semantics; adds the own/grant 403/404 on top.
  if (tableName === 'schedules' || tableName === 'schedule_exceptions') {
    const owner = req.body as Record<string, unknown>;
    const guard = await assertOwnScheduleAllowed(pool, user, {
      professional_user_id: owner?.professional_user_id as number | string | null,
      resource_id: owner?.resource_id as number | string | null,
    });
    if (!guard.ok) {
      return sendError(res, guard.status, guard.code, guard.message);
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
