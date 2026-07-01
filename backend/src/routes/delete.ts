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
import { assertCrudAllowed, assertOwnScheduleAllowed, reNumberFragment } from './crud-policy';
import type { AuthUser } from '../auth';

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

  const pk = validateOnlyPk(tableName, req.query);

  if (sendErrorsIfInvalid(res, pk)) {
    return;
  }

  const pkFields = getPkFields(tableName);
  const pkValues = pkFields.map(
    (pkField) => (pk.data as Record<string, unknown>)[pkField]
  );

  // D-16: own+Admin+granted enforcement for schedule tables — owner read from the existing row.
  if (tableName === 'schedules' || tableName === 'schedule_exceptions') {
    const existing = await pool.query<{ professional_user_id: string | null; resource_id: string | null }>(
      `SELECT professional_user_id, resource_id FROM ${physicalTable} WHERE id = $1`,
      [pkValues[0]]
    );
    if (existing.rows.length === 0) {
      return sendError(res, 404, 'not_found', `${entityName} not found`);
    }
    const guard = await assertOwnScheduleAllowed(pool, user, existing.rows[0]);
    if (!guard.ok) {
      return sendError(res, guard.status, guard.code, guard.message);
    }
  }

  const softDelete = getSoftDeletePolicy(tableName);

  let query: string;
  let params: unknown[];

  if (softDelete) {
    // Referenced core records are archived, never physically removed.
    const actorId = user?.id ?? null;
    const sets = [`${softDelete.deletedAtColumn} = now()`, `updated_at = now()`];
    params = [];
    let nextParam = 1;

    if (softDelete.deletedByColumn) {
      sets.push(`${softDelete.deletedByColumn} = $${nextParam++}`);
      params.push(actorId);
    }

    const whereArguments = columnNamesEqualsNumber(pkFields, nextParam, ' AND ');
    params.push(...pkValues);
    nextParam += pkFields.length;

    // AND scope into WHERE so out-of-scope rows yield rowCount 0 → 404.
    const scopeConditions: string[] = [];
    if (allowed.discriminatorWhere) {
      const { sql, nextIndex } = reNumberFragment(allowed.discriminatorWhere, nextParam);
      scopeConditions.push(sql);
      params.push(...(allowed.discriminatorParams ?? []));
      nextParam = nextIndex;
    }
    if (allowed.businessWhere) {
      const { sql, nextIndex } = reNumberFragment(allowed.businessWhere, nextParam);
      scopeConditions.push(sql);
      params.push(...allowed.businessParams);
      nextParam = nextIndex;
    }
    if (allowed.ownerWhere) {
      const { sql, nextIndex } = reNumberFragment(allowed.ownerWhere, nextParam);
      scopeConditions.push(sql);
      params.push(...(allowed.ownerParams ?? []));
      nextParam = nextIndex;
    }

    const scopeClause = scopeConditions.length > 0 ? ` AND ${scopeConditions.join(' AND ')}` : '';

    query = `
      UPDATE ${physicalTable}
      SET ${sets.join(', ')}
      WHERE ${whereArguments} AND ${softDelete.deletedAtColumn} IS NULL${scopeClause}
      RETURNING *
    `;
  } else {
    const whereArguments = columnNamesEqualsNumber(pkFields, 1, ' AND ');
    params = [...pkValues];
    let nextParam = pkValues.length + 1;

    const scopeConditions: string[] = [];
    if (allowed.discriminatorWhere) {
      const { sql, nextIndex } = reNumberFragment(allowed.discriminatorWhere, nextParam);
      scopeConditions.push(sql);
      params.push(...(allowed.discriminatorParams ?? []));
      nextParam = nextIndex;
    }
    if (allowed.businessWhere) {
      const { sql, nextIndex } = reNumberFragment(allowed.businessWhere, nextParam);
      scopeConditions.push(sql);
      params.push(...allowed.businessParams);
      nextParam = nextIndex;
    }
    if (allowed.ownerWhere) {
      const { sql, nextIndex } = reNumberFragment(allowed.ownerWhere, nextParam);
      scopeConditions.push(sql);
      params.push(...(allowed.ownerParams ?? []));
      nextParam = nextIndex;
    }

    const scopeClause = scopeConditions.length > 0 ? ` AND ${scopeConditions.join(' AND ')}` : '';

    query = `
      DELETE FROM ${physicalTable}
      WHERE ${whereArguments}${scopeClause}
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
