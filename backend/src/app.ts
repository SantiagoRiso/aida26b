import { Pool } from 'pg';
import cors from 'cors';
import path from 'path';
import express from 'express';
import type { RequestHandler } from 'express';
import { getHandler } from './routes/get';
import { putHandler } from './routes/put';
import { postHandler } from './routes/post';
import { deleteHandler } from './routes/delete';
import { requestLogger, getRequestId, logger } from './logger';
import { registerHealthRoute } from './health';
import { mountTelemetryRoutes } from './routes/telemetry';
import { guardRoute } from './helpers';
import { sendError } from './status_messages';
import { httpForStructuredError } from './errors';
import type { AuthUser } from './auth';
import { optionalAuthenticatedUser, setAuthenticatedUser } from './session';
import { API_PREFIX, CRUD_PATTERNS } from '../../shared/src/ssot/api-paths';

export type GenericRouteGuards = {
  read?: RequestHandler[];
  write?: RequestHandler[];
};

export type CreateAppOptions = {
  // When set, every request that has no `req.user` attached by auth middleware
  // will receive this user instead of the hardcoded Admin-null fallback in each
  // handler. Useful in DB tests that need a real business_id without wiring sessions.
  defaultUser?: AuthUser;
  // Express `trust proxy` value; the runtime server sets 1 (one known ingress hop)
  // so req.ip — and the audited IPs derived from it — reflect the real client.
  trustProxy?: number | boolean;
  // Frontend bundle directory for static assets and the SPA fallback.
  distPath?: string;
  // Auth middleware layered onto the generic CRUD routes (runtime only; tests run open).
  genericGuards?: GenericRouteGuards;
  // Mounted between observability and the generic CRUD routes — bespoke routes must win
  // over /api/:tableName, and the generic stack must precede the static/SPA fallback.
  mountDomainRoutes?: (app: express.Express) => void;
};

// Shared generic CRUD route stack so the test app and the runtime server never drift.
export function mountGenericRoutes(
  app: express.Express,
  pool: Pool,
  guards: GenericRouteGuards = {}
) {
  const read = guards.read ?? [];
  const write = guards.write ?? [];

  app.get(CRUD_PATTERNS.collection, ...read, guardRoute((req, res) => getHandler(req, res, pool)));
  app.post(CRUD_PATTERNS.collection, ...write, guardRoute((req, res) => postHandler(req, res, pool)));
  // Frontend calls PUT/DELETE with the row id as a path segment (crud.ts updateRow/deleteRow).
  app.put(CRUD_PATTERNS.item, ...write, guardRoute((req, res) => putHandler(req, res, pool)));
  app.delete(CRUD_PATTERNS.item, ...write, guardRoute((req, res) => deleteHandler(req, res, pool)));
}

// body-parser (via express.json()) wraps a JSON.parse SyntaxError with http-errors and tags it
// with this `type` before express.json() has any chance to reach a route or guardRoute wrapper.
function isMalformedBodyError(
  // eslint-disable-next-line no-restricted-syntax -- catch-boundary: Express hands the terminal handler whatever body-parser or any upstream middleware threw
  err: unknown,
): boolean {
  if (!err || typeof err !== 'object') return false;
  // eslint-disable-next-line no-restricted-syntax -- catch-boundary: narrowing a field of an unverified error shape
  const e = err as { type?: unknown };
  return e.type === 'entity.parse.failed';
}

// Same tagging, raised by a body-parser whose byte limit was exceeded. Without this the caller
// would read a 500 and retry the same oversized body forever.
function isOversizedBodyError(
  // eslint-disable-next-line no-restricted-syntax -- catch-boundary: Express hands the terminal handler whatever body-parser threw
  err: unknown,
): boolean {
  if (!err || typeof err !== 'object') return false;
  // eslint-disable-next-line no-restricted-syntax -- catch-boundary: narrowing a field of an unverified error shape
  const e = err as { type?: unknown };
  return e.type === 'entity.too.large';
}

// Mirrors helpers.ts's logUnhandled shape (same fields, same reqId join) so an error caught here
// reads identically to one caught inside a guarded route, in the same structured log stream.
function logUnhandledError(
  req: express.Request,
  // eslint-disable-next-line no-restricted-syntax -- catch-boundary: narrows an error of unverified shape
  error: unknown,
): void {
  logger.error({
    reqId: getRequestId(req) ?? 'unknown',
    method: req.method,
    path: req.path,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error && error.stack ? error.stack : '',
  });
}

// The single app assembly: the runtime server passes its auth wiring and env-derived paths;
// tests call it bare (no auth, default dist) so both stacks share one middleware order.
export function createApp(pool: Pool, options: CreateAppOptions = {}) {
  const app = express();

  if (options.trustProxy !== undefined) {
    app.set('trust proxy', options.trustProxy);
  }

  // First in the chain, ahead of anything that can throw: it mints the per-request id, so a
  // request that dies inside cors or express.json still gets an access-log line and an error
  // line that can be joined to it. A malformed JSON body fails inside express.json(), so a
  // logger registered after it would leave that error with no request to correlate to.
  app.use(requestLogger());

  app.use(cors());

  // Ahead of the API-wide body parser so the browser-error ingest enforces its own small limit
  // instead of inheriting the 100kb one. Unauthenticated like /health: a crash on the login
  // screen has no session, and that is the crash most worth seeing.
  mountTelemetryRoutes(app);

  app.use(express.json());

  // Inject a default user on every request so handlers that read req.user get a
  // real business context without requiring a session cookie. Only applies when no
  // upstream middleware has already set req.user (so the runtime server is unaffected).
  if (options.defaultUser) {
    const defaultUser = options.defaultUser;
    app.use((req, _res, next) => {
      if (!optionalAuthenticatedUser(req)) setAuthenticatedUser(req, defaultUser);
      next();
    });
  }

  // /health stays unauthenticated so container healthchecks can reach it.
  registerHealthRoute(app, pool);

  options.mountDomainRoutes?.(app);
  mountGenericRoutes(app, pool, options.genericGuards);

  // Anything under /api that fell through every bespoke and generic route is an unmatched
  // endpoint, not a client-side route — answer with the API envelope, never Express's default
  // HTML 404 or the SPA's index.html.
  app.all(`${API_PREFIX}/*`, (_req, res) => {
    sendError(res, 404, 'not_found', 'Not found');
  });

  const distPath = options.distPath ?? path.join(__dirname, '../../frontend/dist');
  app.use(express.static(distPath));

  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });

  // Terminal error handler (4-arg signature required for Express to route errors here). Must be
  // registered last: express.json() throws before any route or guardRoute wrapper runs, so a
  // malformed body reaches this handler directly, never a route. Express only forwards an error
  // to error-handling middleware registered after the point of failure, so this has to sit after
  // every other app.use/route, including the SPA catch-all above.
  app.use((
    // eslint-disable-next-line no-restricted-syntax -- catch-boundary: Express hands this whatever any prior middleware threw or passed to next(err)
    err: unknown,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    // A response mid-flight (e.g. a streaming write failed) can't be reshaped into JSON;
    // defer to Express's default handler, which just terminates the connection.
    if (res.headersSent) {
      next(err);
      return;
    }
    logUnhandledError(req, err);
    if (isMalformedBodyError(err)) {
      sendError(res, 400, 'invalid_request', 'Malformed JSON body');
      return;
    }
    if (isOversizedBodyError(err)) {
      sendError(res, 413, 'payload_too_large', 'Request body too large');
      return;
    }
    const structured = httpForStructuredError(err);
    if (structured) {
      sendError(res, structured.status, structured.code, structured.message, { fields: structured.fields });
      return;
    }
    sendError(res, 500, 'internal_error', 'Internal server error');
  });

  return app;
}
