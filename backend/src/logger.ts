import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import type { Request, RequestHandler } from 'express';

// LOG_LEVEL is read per call so it stays configurable; 'silent' suppresses everything (used by tests).

type Level = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

// VERSION wins when set (the deployed image tag); otherwise the version comes from
// backend/package.json. The manifest is found by walking up rather than by a fixed relative
// path: the compiled tree nests a level deeper than the sources (tsc mirrors the repo root
// because the backend imports shared/), so no single literal path holds in both layouts.
function resolveVersion(): string {
  if (process.env.VERSION) return process.env.VERSION;
  let dir = __dirname;
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string };
      if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
    } catch {
      // no manifest at this level, keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) return 'unknown';
    dir = parent;
  }
}

const VERSION = resolveVersion();

function currentLevel(): Level {
  const env = process.env.LOG_LEVEL;
  return isLevel(env) ? env : 'info';
}

function isLevel(value: string | undefined): value is Level {
  return value !== undefined && Object.prototype.hasOwnProperty.call(LEVELS, value);
}

type LogFields = Record<string, string | number | boolean>;

function emit(level: Exclude<Level, 'silent'>, fields: LogFields) {
  if (LEVELS[level] < LEVELS[currentLevel()]) return;
  const entry = { level, time: new Date().toISOString(), version: VERSION, ...fields };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

export const logger = {
  debug: (fields: LogFields) => emit('debug', fields),
  info: (fields: LogFields) => emit('info', fields),
  warn: (fields: LogFields) => emit('warn', fields),
  error: (fields: LogFields) => emit('error', fields),
};

export type RequestWithId = Request & { reqId?: string };

// Lets error sites (guardRoute/guardMiddleware, the audit writer) join their log line back to
// the requestLogger line for the same request. Undefined when requestLogger never ran (e.g. a
// handler invoked directly in a unit test).
export function getRequestId(req: Request): string | undefined {
  return (req as RequestWithId).reqId;
}

// Never logs the request body.
export function requestLogger(): RequestHandler {
  return (req, res, next) => {
    const reqId = randomUUID();
    (req as RequestWithId).reqId = reqId;
    const start = process.hrtime.bigint();

    // 'close' fires for every request, 'finish' only for responses that were fully sent. A client
    // that navigates away mid-response would otherwise leave no trace at all. Listening on 'close'
    // alone keeps it at exactly one line per request.
    res.on('close', () => {
      const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
      logger.info({
        reqId,
        method: req.method,
        url: req.url,
        status: res.statusCode,
        ms,
        ...(res.writableEnded ? {} : { aborted: true }),
      });
    });

    next();
  };
}
