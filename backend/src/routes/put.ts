import express from 'express';
import { Pool } from 'pg';

import type { Response } from '../../../shared/src/types/types';
import { getPkFields } from '../../../shared/src/utils/utils';

import {
  getEntityName,
  getNotDerivableFields,
  tryQuery,
  columnNamesEqualsNumber,
  getRoleCheckedColumns,
} from '../helpers';

import { sendData, sendError } from '../status_messages';
import { assertCrudAllowed, assertOwnScheduleAllowed, reNumberFragment } from './crud-policy';
import type { AuthUser } from '../auth';
import { tableOf } from '../../../shared/src/utils/utils';
import type { ColumnDef } from '../../../shared/src/types/types';
import { structure } from '../../../shared/src/ssot/structure';

import {
  validateFullObject,
  validateOnlyPk,
  sendErrorsIfInvalid,
} from '../validation/validate';

type AuthedRequest = express.Request & { user?: AuthUser };

// Fields whose values are always derived server-side and must never come from the request body.
const SERVER_DERIVED = new Set(['business_id']);

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

  // D-16: own+Admin+granted enforcement for schedule tables — owner is read from the existing
  // row (authoritative), so a caller cannot edit a peer's row by omitting the owner in the body.
  if (tableName === 'schedules' || tableName === 'schedule_exceptions') {
    const existing = await pool.query<{ professional_user_id: string | null; resource_id: string | null }>(
      `SELECT professional_user_id, resource_id FROM ${physicalTable} WHERE id = $1`,
      [pkValues[0]]
    );
    if (existing.rows.length === 0) {
      return sendError(res, 404, 'not_found', `${entityName} not found`);
    }

    // The owner is identity, not a mutable attribute: forbid reassigning a schedule row to another
    // owner through generic update. Without this, a caller authorized for the existing owner could
    // hand the row to a peer (the guard below only validates the existing owner).
    const body = validatedBody.data as Record<string, unknown>;
    const bodyProf = body.professional_user_id != null ? Number(body.professional_user_id) : null;
    const bodyRes = body.resource_id != null ? Number(body.resource_id) : null;
    const rowProf = existing.rows[0].professional_user_id != null ? Number(existing.rows[0].professional_user_id) : null;
    const rowRes = existing.rows[0].resource_id != null ? Number(existing.rows[0].resource_id) : null;
    if ((bodyProf != null && bodyProf !== rowProf) || (bodyRes != null && bodyRes !== rowRes)) {
      return sendError(res, 403, 'forbidden', 'The owner of a schedule row cannot be changed');
    }

    const guard = await assertOwnScheduleAllowed(pool, user, existing.rows[0]);
    if (!guard.ok) {
      return sendError(res, guard.status, guard.code, guard.message);
    }
  }

  // Verify FK columns with a declared referencesUserRole point to an active user of the
  // right role, and derive the row's tenant from that user rather than the caller. Every
  // role-checked reference must share one business, so no row can mix tenants — enforced
  // even for super-admins, who would otherwise bypass the business restriction entirely.
  // This replaces the removed composite-FK DB constraint.
  const roleChecks = getRoleCheckedColumns(tableName);
  let referencedBusiness: number | undefined;
  for (const { column, role } of roleChecks) {
    const refId = (validatedBody.data as Record<string, unknown>)[column];
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
    (fieldName) => (validatedBody.data as Record<string, unknown>)[fieldName]
  );

  const setArgumentsString = columnNamesEqualsNumber(
    fieldsToUpdate,
    1,
    ', '
  );

  const pkStart = fieldsToUpdate.length + 1;
  const whereArgumentsString = columnNamesEqualsNumber(pkFields, pkStart, ' AND ');

  const scopeStart = pkStart + pkFields.length;
  const scopeParams: unknown[] = [];
  const scopeConditions: string[] = [];
  let nextIdx = scopeStart;

  // Discriminator before business scope for index efficiency.
  if (allowed.discriminatorWhere) {
    const { sql, nextIndex } = reNumberFragment(allowed.discriminatorWhere, nextIdx);
    scopeConditions.push(sql);
    scopeParams.push(...(allowed.discriminatorParams ?? []));
    nextIdx = nextIndex;
  }

  if (allowed.businessWhere) {
    const { sql, nextIndex } = reNumberFragment(allowed.businessWhere, nextIdx);
    scopeConditions.push(sql);
    scopeParams.push(...allowed.businessParams);
    nextIdx = nextIndex;
  }
  if (allowed.ownerWhere) {
    const { sql, nextIndex } = reNumberFragment(allowed.ownerWhere, nextIdx);
    scopeConditions.push(sql);
    scopeParams.push(...(allowed.ownerParams ?? []));
    nextIdx = nextIndex;
  }

  const scopeClause = scopeConditions.length > 0 ? ` AND ${scopeConditions.join(' AND ')}` : '';

  const query = `
    UPDATE ${physicalTable}
    SET ${setArgumentsString}
    WHERE ${whereArgumentsString}${scopeClause}
    RETURNING *
  `;

  const result: Response = await tryQuery(pool, query, [
    ...newValues,
    ...pkValues,
    ...scopeParams,
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
