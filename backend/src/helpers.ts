import type { Request as ExpressRequest, Response as ExpressResponse, NextFunction, RequestHandler } from 'express';
import { sendError } from './status_messages';
import { httpForDbError } from './db/errors';
import { httpForStructuredError } from './errors';

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
        if (!res.headersSent) sendError(res, mapped.status, mapped.code, mapped.message);
        return;
      }
      // App errors that carry their own HTTP mapping
      const structured = httpForStructuredError(error);
      if (structured) {
        if (!res.headersSent) sendError(res, structured.status, structured.code, structured.message, structured.fields);
        return;
      }
      console.error(`Unhandled error in ${req.method} ${req.path}:`, error);
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
        if (!res.headersSent) sendError(res, mapped.status, mapped.code, mapped.message);
        return;
      }
      const structured = httpForStructuredError(error);
      if (structured) {
        if (!res.headersSent) sendError(res, structured.status, structured.code, structured.message, structured.fields);
        return;
      }
      console.error(`Unhandled error in ${req.method} ${req.path}:`, error);
      if (!res.headersSent) sendError(res, 500, 'internal_error', 'Internal server error');
    }
  };
}

export { guardRoute, guardMiddleware };
