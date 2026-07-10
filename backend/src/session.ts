import type { Request, RequestHandler } from 'express';
import type { Pool } from 'pg';
import * as auth from './auth';
import { guardMiddleware } from './helpers';
import { sendError } from './status_messages';
import { loadSessionUser } from './db/auth';
import { getUserBusinessId } from './db/users';
import { insertAuditEvent } from './db/audit';
import type { ColumnValue } from '../../shared/src/types/types';

type AuthedRequest = Request & { user?: auth.AuthUser };

export function getSessionToken(req: Request): string | undefined {
  return auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE];
}

// A submitted password is only accepted once it clears the minimum length — shared by the
// change-password and admin create/reset paths so the rule lives in one place.
export function readPassword(value: string | undefined): string | null {
  return typeof value === 'string' && value.length >= 8 ? value : null;
}

export async function loadSession(pool: Pool, req: Request) {
  const token = getSessionToken(req);
  if (!token) return null;

  const row = await loadSessionUser(pool, auth.hashToken(token));
  return row ? auth.publicUser(row) : null;
}

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

export interface AuthGuards {
  requireAuth: RequestHandler;
  requirePasswordReady: RequestHandler;
  requireAdmin: RequestHandler;
}

// requireAdmin audits the denial so a forbidden admin action leaves a trace.
export function createAuthGuards(pool: Pool, audit: AuditWriter): AuthGuards {
  const requireAuth: RequestHandler = guardMiddleware(async (req, res, next) => {
    const user = await loadSession(pool, req);
    if (!user) {
      return sendError(res, 401, 'unauthorized', 'Authentication required');
    }
    (req as AuthedRequest).user = user;
    next();
  });

  const requirePasswordReady: RequestHandler = (req, res, next) => {
    if ((req as AuthedRequest).user?.must_change_password) {
      return sendError(res, 403, 'password_change_required', 'Password change required');
    }
    next();
  };

  const requireAdmin: RequestHandler = guardMiddleware(async (req, res, next) => {
    if ((req as AuthedRequest).user?.role === 'Admin') {
      return next();
    }
    await audit(req, 'permission_denied', 'denied', { path: req.path, method: req.method });
    return sendError(res, 403, 'forbidden', 'Forbidden');
  });

  return { requireAuth, requirePasswordReady, requireAdmin };
}
