import { query } from './core';
import type { Queryable } from './core';
import type { AuditEventRow } from '../../../shared/src/ssot/query-types';
import type { SqlParam } from '../../../shared/src/types/types';

// ip is null for in-transaction writes (auditInTx) that don't carry a request.
export async function insertAuditEvent(
  db: Queryable,
  e: {
    businessId: number;
    actorId: number | null;
    eventType: string;
    entityType: string | null;
    entityId: number | null;
    outcome: string;
    ip: string | null;
    detailsJson: string;
  },
): Promise<void> {
  await query(
    db,
    `INSERT INTO audit_events
       (business_id, actor_user_id, event_type, entity_type, entity_id, outcome, ip, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.businessId, e.actorId, e.eventType, e.entityType, e.entityId, e.outcome, e.ip, e.detailsJson],
  );
}

export type AuditListFilter = {
  businessId: number;
  entityType?: string;
  actorUserId?: number;
  eventType?: string;
  outcome?: string;
  dateFrom?: string;
  dateTo?: string;
  limit: number;
  offset: number;
};

// Only code-controlled column names are interpolated; every filter value is a bound $N param.
export async function listAuditEvents(
  db: Queryable,
  f: AuditListFilter,
): Promise<{ rows: AuditEventRow[]; total: number }> {
  const conditions: string[] = ['a.business_id = $1'];
  const params: SqlParam[] = [f.businessId];
  let p = 2;

  if (f.entityType != null) { conditions.push(`a.entity_type = $${p++}`); params.push(f.entityType); }
  if (f.actorUserId != null) { conditions.push(`a.actor_user_id = $${p++}`); params.push(f.actorUserId); }
  if (f.eventType != null) { conditions.push(`a.event_type = $${p++}`); params.push(f.eventType); }
  if (f.outcome != null) { conditions.push(`a.outcome = $${p++}`); params.push(f.outcome); }
  if (f.dateFrom != null) { conditions.push(`a.created_at >= $${p++}`); params.push(f.dateFrom); }
  if (f.dateTo != null) { conditions.push(`a.created_at <= $${p++}`); params.push(f.dateTo); }

  const where = conditions.join(' AND ');

  const [rows, count] = await Promise.all([
    query<AuditEventRow>(
      db,
      `SELECT a.id, a.actor_user_id, a.event_type, a.entity_type, a.entity_id,
              a.outcome, a.ip, a.details, a.created_at
         FROM audit_events a
        WHERE ${where}
        ORDER BY a.created_at DESC
        LIMIT $${p} OFFSET $${p + 1}`,
      [...params, f.limit, f.offset],
    ),
    query<{ n: string }>(
      db,
      `SELECT count(*)::text AS n FROM audit_events a WHERE ${where}`,
      params,
    ),
  ]);

  return { rows, total: Number(count[0].n) };
}
