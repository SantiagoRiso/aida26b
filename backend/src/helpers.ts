import type { Request as ExpressRequest, Response as ExpressResponse, NextFunction, RequestHandler } from 'express';
import { sendError } from './status_messages';
import { httpForDbError } from './db/errors';
import { httpForStructuredError } from './errors';
import { getRequestId, logger } from './logger';

// reqId (set by requestLogger upstream) joins this line back to the request's access-log entry;
// falls back to 'unknown' only when a handler is invoked outside that middleware (e.g. a test).
// eslint-disable-next-line no-restricted-syntax -- catch-boundary: the thrown value's shape is unverified until narrowed below
function logUnhandled(req: ExpressRequest, error: unknown): void {
  logger.error({
    reqId: getRequestId(req) ?? 'unknown',
    method: req.method,
    path: req.path,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error && error.stack ? error.stack : '',
  });
}

// Express 4 does not catch rejected async handlers — one uncaught rejection kills the whole
// process. These wrappers are the crash net; structured error handling stays in the handlers.
function guardRoute(
  fn: (req: ExpressRequest, res: ExpressResponse) => Promise<ExpressResponse | void>,
): RequestHandler {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      const mapped = httpForDbError(error);
      if (mapped) {
        if (!res.headersSent) sendError(res, mapped.status, mapped.code, mapped.message, { detail: mapped.detail });
        return;
      }
      // App errors that carry their own HTTP mapping
      const structured = httpForStructuredError(error);
      if (structured) {
        if (!res.headersSent) sendError(res, structured.status, structured.code, structured.message, { fields: structured.fields });
        return;
      }
      logUnhandled(req, error);
      if (!res.headersSent) sendError(res, 500, 'internal_error', 'Internal server error');
    }
  };
}

// For async middleware. On rejection the request ends here (no next()): a failed
// auth/authz guard must never let the request fall through to the protected handler.
function guardMiddleware(
  fn: (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => Promise<ExpressResponse | void>,
): RequestHandler {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (error) {
      const mapped = httpForDbError(error);
      if (mapped) {
        if (!res.headersSent) sendError(res, mapped.status, mapped.code, mapped.message, { detail: mapped.detail });
        return;
      }
      const structured = httpForStructuredError(error);
      if (structured) {
        if (!res.headersSent) sendError(res, structured.status, structured.code, structured.message, { fields: structured.fields });
        return;
      }
      logUnhandled(req, error);
      if (!res.headersSent) sendError(res, 500, 'internal_error', 'Internal server error');
    }
  };
}

export { guardRoute, guardMiddleware };
