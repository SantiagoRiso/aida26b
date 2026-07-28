import type { Request } from 'express';
import type { Pool } from 'pg';

import { createAuditWriter } from '../audit';
import type { AuditWriter } from '../audit';
import { getPkFields } from '../../../shared/src/utils/utils';
import { WRITE_EVENT_SUFFIX } from '../../../shared/src/ssot/domain/audit-events';
import type { TableKey } from '../../../shared/src/ssot/derived';
import type { GenericRow } from '../../../shared/src/ssot/query-types';

export type WriteOperation = keyof typeof WRITE_EVENT_SUFFIX;

// Entity and action come from the SSOT table key and the op, so a newly exposed table is audited
// without editing this file — there is no per-table event list to keep in sync.
export function crudEventType(table: TableKey, op: WriteOperation): string {
  return `${table}_${WRITE_EVENT_SUFFIX[op]}`;
}

// The bespoke routes are handed a writer at mount time; the generic handlers only receive a pool,
// and createAuditWriter closes over nothing else, so one writer per pool is reused.
const writers = new WeakMap<Pool, AuditWriter>();

function writerFor(pool: Pool): AuditWriter {
  const existing = writers.get(pool);
  if (existing) return existing;
  const writer = createAuditWriter(pool);
  writers.set(pool, writer);
  return writer;
}

// Best-effort, matching every other pool-based call site: a generic write is a single
// autocommitted statement, so the row is already durable here and a failed audit must not turn a
// completed write into an error response.
export async function auditGenericWrite(
  pool: Pool,
  req: Request,
  table: TableKey,
  op: WriteOperation,
  row: GenericRow,
): Promise<void> {
  const pkValue = Number(row[getPkFields(table)[0]]);
  await writerFor(pool)(req, crudEventType(table, op), 'success', {
    entity_type: table,
    entity_id: Number.isFinite(pkValue) ? pkValue : null,
  });
}

// Same shape requireAdmin records, so a denial from the generic engine and one from the admin
// gate read identically in the audit log.
export async function auditGenericDenied(
  pool: Pool,
  req: Request,
  denial: { code: string },
): Promise<void> {
  await writerFor(pool)(req, 'permission_denied', 'denied', {
    path: req.path,
    method: req.method,
    reason: denial.code,
  });
}
