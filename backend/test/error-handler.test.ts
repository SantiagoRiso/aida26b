import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { createApp } from '../src/app';
import type { ApiErrorEnvelope } from '../../shared/src/ssot/envelope';

type LogEntry = Record<string, string | number>;

// Captures the structured log stream around an async request. Non-JSON writes (vitest's own
// reporter output) are dropped so only logger lines are asserted on.
async function captureLogs(fn: () => Promise<void>): Promise<LogEntry[]> {
  const lines: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line no-restricted-syntax -- monkey-patching Node's overloaded stdout.write signature for output capture; a test stub can't match its full stdlib overload set
  const stdout = process.stdout as unknown as { write: (chunk: string | Buffer) => boolean };
  stdout.write = (chunk: string | Buffer) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    stdout.write = realWrite;
  }
  return lines
    .join('')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as LogEntry);
}

// Neither scenario below reaches the database: a malformed body fails inside express.json()
// before any route runs, and an unmatched /api path is answered before the generic CRUD/db
// handlers are ever invoked. A stub pool keeps this suite out of the .db.test.ts split.
const unusedPool = {} as Pool;

describe('terminal error handling', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = createApp(unusedPool);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('a malformed JSON body answers the standard error envelope, not an HTML stack trace', async () => {
    const response = await fetch(`${baseUrl}/api/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"name":',
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');

    const text = await response.text();
    expect(text).not.toContain('<html');
    expect(text).not.toContain('node_modules');
    expect(text).not.toContain('at ');

    const body = JSON.parse(text) as ApiErrorEnvelope;
    expect(body).toEqual({
      success: false,
      error: { code: 'invalid_request', message: 'Malformed JSON body' },
    });
  });

  // The failure this handler exists for happens inside express.json(), so the request id has to
  // be minted upstream of it or the error can never be joined back to the request that caused it.
  it('a malformed body logs an error line carrying the same reqId as its access-log line', async () => {
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'info';
    let entries: LogEntry[] = [];

    try {
      entries = await captureLogs(async () => {
        const response = await fetch(`${baseUrl}/api/services`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"name":',
        });
        await response.text();
        // The access-log line is emitted on the response's 'finish' event, which can land a
        // tick after the client's fetch resolves.
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    } finally {
      if (previousLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLevel;
    }

    const errorLine = entries.find((entry) => entry.level === 'error');
    const accessLine = entries.find((entry) => entry.level === 'info' && entry.url === '/api/services');
    if (!errorLine) throw new Error('expected an error log line for the malformed body');
    if (!accessLine) throw new Error('expected an access-log line for the malformed body request');

    expect(accessLine.status).toBe(400);
    expect(typeof errorLine.reqId).toBe('string');
    expect(errorLine.reqId).not.toBe('unknown');
    expect(errorLine.reqId).toBe(accessLine.reqId);
  });

  it('a POST to an unmatched /api path answers a JSON 404, not Express\'s default HTML 404', async () => {
    const response = await fetch(`${baseUrl}/api/this/path/does/not/exist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');

    const body = (await response.json()) as ApiErrorEnvelope;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('not_found');
  });

  it('a PUT to an unmatched /api path also answers a JSON 404', async () => {
    const response = await fetch(`${baseUrl}/api/nope`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    // /api/:tableName matches PUT too under CRUD_PATTERNS.item's shape, but a bare
    // /api/nope has no :id segment, so it never matches CRUD_PATTERNS.item and should
    // fall through to the API-wide 404, never the SPA HTML fallback.
    expect(response.status).toBe(404);
    const body = (await response.json()) as ApiErrorEnvelope;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('not_found');
  });
});
