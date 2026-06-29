import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { logger, requestLogger } from '../src/logger';

const ORIGINAL_LEVEL = process.env.LOG_LEVEL;

afterEach(() => {
  if (ORIGINAL_LEVEL === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = ORIGINAL_LEVEL;
});

function capture(fn: () => void): Array<Record<string, any>> {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (chunk: any) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    (process.stdout as any).write = original;
  }
  return lines.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('structured logger', () => {
  it('emits one JSON line carrying level, version and time', () => {
    process.env.LOG_LEVEL = 'info';
    const [entry] = capture(() => logger.info({ msg: 'hello' }));
    expect(entry.level).toBe('info');
    expect(typeof entry.version).toBe('string');
    expect(typeof entry.time).toBe('string');
    expect(entry.msg).toBe('hello');
  });

  it('respects LOG_LEVEL filtering', () => {
    process.env.LOG_LEVEL = 'info';
    expect(capture(() => logger.debug({ x: 1 })).length).toBe(0);
    process.env.LOG_LEVEL = 'debug';
    expect(capture(() => logger.debug({ x: 1 })).length).toBe(1);
  });

  it('silent suppresses everything', () => {
    process.env.LOG_LEVEL = 'silent';
    expect(capture(() => logger.error({ x: 1 })).length).toBe(0);
  });
});

describe('request logger middleware', () => {
  it('logs request context on finish but never the request body', () => {
    process.env.LOG_LEVEL = 'info';
    const req: any = { method: 'POST', url: '/api/clients', body: { secret: 'do-not-log' } };
    const res: any = new EventEmitter();
    res.statusCode = 201;

    const entries = capture(() => {
      requestLogger()(req, res, () => {});
      res.emit('finish');
    });

    const entry = entries.find((e) => e.url === '/api/clients');
    expect(entry).toBeTruthy();
    expect(entry.method).toBe('POST');
    expect(entry.status).toBe(201);
    expect(typeof entry.reqId).toBe('string');
    expect('body' in entry).toBe(false);
  });
});
