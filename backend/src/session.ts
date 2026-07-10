import type { Request, RequestHandler } from 'express';
import type { Pool } from 'pg';
import * as auth from './auth';
import { guardMiddleware } from './helpers';
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

  const result = await pool.query(
    `SELECT
       s.id AS session_id,
       u.id,
       u.username,
       u.email,
       u.role,
       u.business_id,
       u.is_active,
       u.must_change_password
     FROM auth.sessions s
     JOIN auth.users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.expires_at > now()
       AND u.is_active = true`,
    [auth.hashToken(token)],
  );

  return result.rows[0] ? auth.publicUser(result.rows[0]) : null;
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
        const business = await pool.query<{ business_id: number | null }>(
          'SELECT business_id FROM auth.users WHERE id = $1',
          [actorId],
        );
        businessId = business.rows[0]?.business_id ?? null;
      }

      if (businessId === null) return;

      await pool.query(
        `INSERT INTO audit_events
         (business_id, actor_user_id, event_type, entity_type, entity_id, outcome, ip, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          businessId,
          actorId,
          eventType,
          (details.entity_type as string) ?? null,
          (details.entity_id as number) ?? null,
          outcome,
          req.ip,
          JSON.stringify(details),
        ],
      );
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

// The runtime auth guards, bound to a pool and the audit writer. requireAdmin audits the denial
// so a forbidden admin action leaves a trace.
export function createAuthGuards(pool: Pool, audit: AuditWriter): AuthGuards {
  const requireAuth: RequestHandler = guardMiddleware(async (req, res, next) => {
    const user = await loadSession(pool, req);
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    (req as AuthedRequest).user = user;
    next();
  });

  const requirePasswordReady: RequestHandler = (req, res, next) => {
    if ((req as AuthedRequest).user?.must_change_password) {
      return res.status(403).json({ error: 'Password change required' });
    }
    next();
  };

  const requireAdmin: RequestHandler = guardMiddleware(async (req, res, next) => {
    if ((req as AuthedRequest).user?.role === 'Admin') {
      return next();
    }
    await audit(req, 'permission_denied', 'denied', { path: req.path, method: req.method });
    return res.status(403).json({ error: 'Forbidden' });
  });

  return { requireAuth, requirePasswordReady, requireAdmin };
}
