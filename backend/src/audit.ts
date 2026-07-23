import type { Request } from 'express';
import type { Pool } from 'pg';
import { optionalAuthenticatedUser } from './session';
import { getUserBusinessId } from './db/users';
import { insertAuditEvent } from './db/audit';
import type { ColumnValue } from '../../shared/src/types/types';
import { getRequestId, logger } from './logger';

export type AuditWriter = (
  req: Request,
  eventType: string,
  outcome: string,
  details?: Record<string, ColumnValue>,
  override?: { actorId?: number | null; businessId?: number | null },
) => Promise<void>;

// By default the business is derived from the actor's session. An unauthenticated request with no
// explicit scope is dropped rather than filed under a guess — this is the anti-DoS gate, since an
// authenticated actor bounds the volume to a session while an anonymous one does not. An
// authenticated actor whose own business is null is the super-admin: its scope is genuinely absent,
// not unknown, so its event (including a denial) is recorded against no tenant rather than
// discarded. Callers may instead pass an explicit actor/business to record events with no session
// (e.g. a failed login, resolved from the attempted account); an explicit null business is a
// deliberate "this belongs to no tenant" and is recorded as such. Best-effort: a failure never
// breaks the request.
export function createAuditWriter(pool: Pool): AuditWriter {
  return async function audit(req, eventType, outcome, details = {}, override = {}) {
    try {
      const actorId =
        override.actorId !== undefined
          ? override.actorId
          : optionalAuthenticatedUser(req)?.id ?? null;

      let businessId: number | null;
      if (override.businessId !== undefined) {
        businessId = override.businessId;
      } else {
        if (actorId === null) return;
        businessId = await getUserBusinessId(pool, actorId);
      }

      const entityType = typeof details.entity_type === 'string' ? details.entity_type : null;
      const entityId = typeof details.entity_id === 'number' ? details.entity_id : null;

      await insertAuditEvent(pool, {
        businessId,
        actorId,
        eventType,
        entityType,
        entityId,
        outcome,
        ip: req.ip ?? null,
        detailsJson: JSON.stringify(details),
      });
    } catch (error) {
      // Best-effort by design (see function comment) — log so a broken audit trail is
      // still visible in the structured stream, joined to the request that triggered it.
      logger.error({
        reqId: getRequestId(req) ?? 'unknown',
        eventType,
        outcome,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
