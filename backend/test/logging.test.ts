import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger, requestLogger } from '../src/logger';

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }
).version;

const ORIGINAL_LEVEL = process.env.LOG_LEVEL;

afterEach(() => {
  if (ORIGINAL_LEVEL === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = ORIGINAL_LEVEL;
});

function capture(fn: () => void): Array<Record<string, string | number | boolean>> {
  const lines: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line no-restricted-syntax -- monkey-patching Node's overloaded stdout.write signature for output capture; a test stub can't match its full stdlib overload set
  const stdout = process.stdout as unknown as { write: (chunk: string | Buffer) => boolean };
  stdout.write = (chunk: string | Buffer) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    stdout.write = realWrite;
  }
  return lines.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('structured logger', () => {
  it('emits one JSON line carrying level, version and time', () => {
    process.env.LOG_LEVEL = 'info';
    const [entry] = capture(() => logger.info({ msg: 'hello' }));
    expect(entry.level).toBe('info');
    expect(typeof entry.time).toBe('string');
    expect(entry.msg).toBe('hello');
  });

  // 'unknown' is what a broken manifest lookup produces, and it satisfies a typeof check — so the
  // assertion has to be the real version. Guards the source-vs-compiled path difference.
  it('stamps the backend package version, not a placeholder', () => {
    process.env.LOG_LEVEL = 'info';
    const [entry] = capture(() => logger.info({ msg: 'hello' }));
    expect(entry.version).toBe(process.env.VERSION ?? PACKAGE_VERSION);
    expect(entry.version).not.toBe('unknown');
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

function fakeRequest(url: string): Request {
  // eslint-disable-next-line no-restricted-syntax -- partial mock of Express's Request — implementing its full interface isn't practical for a test double
  return { method: 'POST', url, body: { secret: 'do-not-log' } } as unknown as Request;
}

function fakeResponse(statusCode: number, writableEnded: boolean): Response {
  // eslint-disable-next-line no-restricted-syntax -- partial mock of Express's Response; EventEmitter supplies the .on('close') this middleware relies on
  const res = new EventEmitter() as unknown as Response;
  res.statusCode = statusCode;
  // Read-only getter on the real ServerResponse, so it is defined rather than assigned.
  Object.defineProperty(res, 'writableEnded', { value: writableEnded, configurable: true });
  return res;
}

describe('request logger middleware', () => {
  it('logs request context but never the request body', () => {
    process.env.LOG_LEVEL = 'info';
    const req = fakeRequest('/api/clients');
    const res = fakeResponse(201, true);

    const entries = capture(() => {
      requestLogger()(req, res, () => {});
      res.emit('finish');
      res.emit('close');
    });

    const entry = entries.find((e) => e.url === '/api/clients');
    if (!entry) throw new Error('expected an access-log entry for /api/clients');
    expect(entry.method).toBe('POST');
    expect(entry.status).toBe(201);
    expect(typeof entry.reqId).toBe('string');
    expect('body' in entry).toBe(false);
    expect('aborted' in entry).toBe(false);
  });

  it('emits exactly one line when both finish and close fire', () => {
    process.env.LOG_LEVEL = 'info';
    const req = fakeRequest('/api/services');
    const res = fakeResponse(200, true);

    const entries = capture(() => {
      requestLogger()(req, res, () => {});
      res.emit('finish');
      res.emit('close');
    });

    expect(entries.filter((e) => e.url === '/api/services').length).toBe(1);
  });

  // A client that disconnects mid-response never emits 'finish'; the request must still be logged.
  it('logs a request the client aborted, flagged as aborted', () => {
    process.env.LOG_LEVEL = 'info';
    const req = fakeRequest('/api/appointments');
    const res = fakeResponse(200, false);

    const entries = capture(() => {
      requestLogger()(req, res, () => {});
      res.emit('close');
    });

    const entry = entries.find((e) => e.url === '/api/appointments');
    if (!entry) throw new Error('expected an access-log entry for an aborted request');
    expect(entry.aborted).toBe(true);
  });
});
