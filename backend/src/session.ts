import type { Request, RequestHandler } from 'express';
import type { Pool } from 'pg';
import * as auth from './auth';
import type { AuditWriter } from './audit';
import { guardMiddleware } from './helpers';
import { sendError } from './status_messages';
import { loadSessionUser } from './db/auth';
import { httpError } from './errors';

export type AuthedRequest = Request & { user?: auth.AuthUser };

export function optionalAuthenticatedUser(req: Request): auth.AuthUser | undefined {
  return (req as AuthedRequest).user;
}

export function authenticatedUser(req: Request): auth.AuthUser {
  const user = optionalAuthenticatedUser(req);
  if (!user) throw httpError(401, 'unauthorized', 'Authentication required');
  return user;
}

export function setAuthenticatedUser(req: Request, user: auth.AuthUser): void {
  (req as AuthedRequest).user = user;
}

export function getSessionToken(req: Request): string | undefined {
  return auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE];
}

export async function loadSession(pool: Pool, req: Request) {
  const token = getSessionToken(req);
  if (!token) return null;

  const row = await loadSessionUser(pool, auth.hashToken(token));
  return row ? auth.publicUser(row) : null;
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
    setAuthenticatedUser(req, user);
    next();
  });

  const requirePasswordReady: RequestHandler = (req, res, next) => {
    if (authenticatedUser(req).must_change_password) {
      return sendError(res, 403, 'password_change_required', 'Password change required');
    }
    next();
  };

  const requireAdmin: RequestHandler = guardMiddleware(async (req, res, next) => {
    if (authenticatedUser(req).role === 'Admin') {
      return next();
    }
    await audit(req, 'permission_denied', 'denied', { path: req.path, method: req.method });
    return sendError(res, 403, 'forbidden', 'Forbidden');
  });

  return { requireAuth, requirePasswordReady, requireAdmin };
}
