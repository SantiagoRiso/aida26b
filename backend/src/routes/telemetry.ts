import express from 'express';
import type { Express, Request } from 'express';
import { guardRoute } from '../helpers';
import { sendError } from '../status_messages';
import { getRequestId, logger } from '../logger';
import { AuthThrottle } from '../auth-throttle';
import type { ThrottleLimit } from '../auth-throttle';
import { TELEMETRY_PATTERNS } from '../../../shared/src/ssot/api-paths';
import {
  BROWSER_ERROR_MAX_BODY_BYTES,
  BROWSER_ERROR_MAX_PER_WINDOW,
  BROWSER_ERROR_WINDOW_MS,
  clipReportField,
  isBrowserErrorSource,
} from '../../../shared/src/ssot/telemetry';
import type { BrowserErrorReport } from '../../../shared/src/ssot/telemetry';

// Browser error reports go to the operational log stream and nowhere else.
//
// Not audit_events: that table is append-only, tenant-scoped and NOT NULL on the columns an
// anonymous report cannot supply, and it exists to record what people did to the business, not
// what broke on their screen. Wiring an unauthenticated endpoint to a table the application is
// not allowed to delete from hands anyone who can load the page an unbounded, irreversible write.
//
// Not a new table either: these reports are diagnostics with no domain meaning and no reader
// inside the product. They belong beside the access log, where they can be joined by reqId.
//
// The report text is attacker-controlled, so it is never interpolated anywhere: it is passed as
// a field value to the JSON logger, which escapes it, so it cannot forge a log line or a field.

// eslint-disable-next-line no-restricted-syntax -- boundary: a field of an untrusted request body
function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? clipReportField(value.trim()) : undefined;
}

function browserErrorLimits(client: string): ThrottleLimit[] {
  return [{ key: `browser-error:${client}`, max: BROWSER_ERROR_MAX_PER_WINDOW }];
}

// eslint-disable-next-line no-restricted-syntax -- boundary: the request body is untrusted until narrowed here
function parseReport(body: unknown): BrowserErrorReport | null {
  if (!body || typeof body !== 'object') return null;
  // eslint-disable-next-line no-restricted-syntax -- boundary: reading fields off an unverified shape
  const raw = body as Record<string, unknown>;

  const source = typeof raw.source === 'string' ? raw.source : '';
  if (!isBrowserErrorSource(source)) return null;

  const message = readString(raw.message);
  if (message === undefined) return null;

  const report: BrowserErrorReport = { source, message };
  const context = readString(raw.context);
  if (context !== undefined) report.context = context;
  const path = readString(raw.path);
  if (path !== undefined) report.path = path;
  const page = readString(raw.page);
  if (page !== undefined) report.page = page;
  if (typeof raw.status === 'number' && Number.isInteger(raw.status)) report.status = raw.status;

  return report;
}

export function mountTelemetryRoutes(app: Express, deps: { throttle?: AuthThrottle } = {}) {
  const throttle = deps.throttle ?? new AuthThrottle({ windowMs: BROWSER_ERROR_WINDOW_MS });

  app.post(
    TELEMETRY_PATTERNS.browserError,
    // This route's own parser, with its own limit: a body over the cap is refused before the
    // API-wide parser (100kb) would have accepted it.
    express.json({ limit: BROWSER_ERROR_MAX_BODY_BYTES }),
    guardRoute(async (req: Request, res) => {
      const client = req.ip ?? 'unknown';
      const limits = browserErrorLimits(client);
      const verdict = throttle.check(limits);
      if (verdict.blocked) {
        res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
        return sendError(res, 429, 'too_many_attempts', 'Too many attempts');
      }

      const report = parseReport(req.body);
      if (!report) {
        return sendError(res, 400, 'invalid_request', 'Unrecognised error report');
      }

      // Every accepted report spends budget, not only malformed ones: the cost this bounds is
      // the log write, which a well-formed report incurs just the same.
      throttle.recordFailure(limits);

      logger.warn({
        kind: 'browser_error',
        reqId: getRequestId(req) ?? 'unknown',
        source: report.source,
        message: report.message,
        context: report.context ?? '',
        errorPath: report.path ?? '',
        errorStatus: report.status ?? 0,
        page: report.page ?? '',
      });

      // Nothing to return, and nothing an attacker can read back.
      return res.status(204).send();
    }),
  );
}
