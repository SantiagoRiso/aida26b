import type { Request } from 'express';
import type { Pool } from 'pg';
import type { AuthedRequest } from './session';
import { getUserBusinessId } from './db/users';
import { insertAuditEvent } from './db/audit';
import type { ColumnValue } from '../../shared/src/types/types';

export type AuditWriter = (
  req: Request,
  eventType: string,
  outcome: string,
  details?: Record<string, ColumnValue>,
  override?: { actorId?: number | null; businessId?: number | null },
) => Promise<void>;

// audit_events.business_id is NOT NULL. By default the business is derived from the actor's
// session; callers may pass an explicit actor/business to record events with no session
// (e.g. a failed login, resolved from the attempted account). The write is skipped only when
// no business resolves. Best-effort: a failure never breaks the request.
export function createAuditWriter(pool: Pool): AuditWriter {
  return async function audit(req, eventType, outcome, details = {}, override = {}) {
    try {
      const actorId =
        override.actorId !== undefined
          ? override.actorId
          : (req as AuthedRequest).user?.id ?? null;

      let businessId: number | null;
      if (override.businessId !== undefined) {
        businessId = override.businessId;
      } else {
        if (actorId === null) return;
        businessId = await getUserBusinessId(pool, actorId);
      }

      if (businessId === null) return;

      await insertAuditEvent(pool, {
        businessId,
        actorId,
        eventType,
        entityType: (details.entity_type as string) ?? null,
        entityId: (details.entity_id as number) ?? null,
        outcome,
        ip: req.ip ?? null,
        detailsJson: JSON.stringify(details),
      });
    } catch (error) {
      console.error('Error writing audit event:', error);
    }
  };
}
