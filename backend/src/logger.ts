import { randomUUID } from 'crypto';
import type { RequestHandler } from 'express';

// LOG_LEVEL is read per call so it stays configurable; 'silent' suppresses everything (used by tests).

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
  return isLevel(env) ? env : 'info';
}

function isLevel(value: string | undefined): value is Level {
  return value !== undefined && Object.prototype.hasOwnProperty.call(LEVELS, value);
}

type LogFields = Record<string, string | number>;

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

// Never logs the request body.
export function requestLogger(): RequestHandler {
  return (req, res, next) => {
    const reqId = randomUUID();
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
