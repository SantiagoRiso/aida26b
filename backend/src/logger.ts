import { randomUUID } from 'crypto';
import type { RequestHandler } from 'express';

// Structured JSON logger. LOG_LEVEL is read per call so it stays configurable;
// 'silent' suppresses everything (used by tests).

type Level = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function resolveVersion(): string {
  if (process.env.VERSION) return process.env.VERSION;
  try {
    return require('../package.json').version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const VERSION = resolveVersion();

function currentLevel(): Level {
  const env = process.env.LOG_LEVEL;
  return env && env in LEVELS ? (env as Level) : 'info';
}

function emit(level: Exclude<Level, 'silent'>, fields: Record<string, unknown>) {
  if (LEVELS[level] < LEVELS[currentLevel()]) return;
  const entry = { level, time: new Date().toISOString(), version: VERSION, ...fields };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

export const logger = {
  debug: (fields: Record<string, unknown>) => emit('debug', fields),
  info: (fields: Record<string, unknown>) => emit('info', fields),
  warn: (fields: Record<string, unknown>) => emit('warn', fields),
  error: (fields: Record<string, unknown>) => emit('error', fields),
};

// Per-request log on completion. Never logs the request body.
export function requestLogger(): RequestHandler {
  return (req, res, next) => {
    const reqId = randomUUID();
    (req as { reqId?: string }).reqId = reqId;
    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
      logger.info({
        reqId,
        method: req.method,
        url: req.url,
        status: res.statusCode,
        ms,
      });
    });

    next();
  };
}
