import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { createApp } from '../src/app';
import type { ApiErrorEnvelope } from '../../shared/src/ssot/envelope';
import { telemetryPaths } from '../../shared/src/ssot/api-paths';
import {
  BROWSER_ERROR_MAX_FIELD_CHARS,
  BROWSER_ERROR_MAX_PER_WINDOW,
} from '../../shared/src/ssot/telemetry';

type LogEntry = Record<string, string | number>;

async function captureLogs(fn: () => Promise<void>): Promise<LogEntry[]> {
  const lines: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line no-restricted-syntax -- monkey-patching Node's overloaded stdout.write signature for output capture; a test stub can't match its full stdlib overload set
  const stdout = process.stdout as unknown as { write: (chunk: string | Buffer) => boolean };
  stdout.write = (chunk: string | Buffer) => {
    lines.push(String(chunk));
    return true;
  };
  const previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  try {
    await fn();
  } finally {
    stdout.write = realWrite;
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
  }
  return lines
    .join('')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as LogEntry);
}

// An empty object stands in for the pool: any database access from this route would throw here.
// That the endpoint answers at all is the proof that a browser error never touches the database.
const unusedPool = {} as Pool;

const INGEST_PATH = `/api${telemetryPaths.browserError()}`;

async function startApp(): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(createApp(unusedPool));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stop(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}

function post(baseUrl: string, body: string): Promise<Response> {
  return fetch(`${baseUrl}${INGEST_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

describe('browser error ingest', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startApp());
  });

  afterAll(async () => {
    await stop(server);
  });

  it('accepts a well-formed contract failure and logs it against the request id', async () => {
    let status = 0;
    const entries = await captureLogs(async () => {
      const response = await post(baseUrl, JSON.stringify({
        source: 'contract',
        message: '$.id: expected finite number',
        path: '/appointments/1',
        status: 200,
        page: '/turnos',
      }));
      status = response.status;
      await response.text();
      // The access-log line lands on the response's 'finish' event, a tick after fetch resolves.
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(status).toBe(204);

    const reportLine = entries.find((entry) => entry.kind === 'browser_error');
    const accessLine = entries.find((entry) => entry.level === 'info' && entry.url === INGEST_PATH);
    if (!reportLine) throw new Error('expected a browser_error log line');
    if (!accessLine) throw new Error('expected an access-log line for the report');

    expect(reportLine.level).toBe('warn');
    expect(reportLine.source).toBe('contract');
    expect(reportLine.message).toBe('$.id: expected finite number');
    expect(reportLine.errorPath).toBe('/appointments/1');
    expect(reportLine.errorStatus).toBe(200);
    expect(reportLine.page).toBe('/turnos');
    expect(reportLine.reqId).toBe(accessLine.reqId);
  });

  it('accepts a render failure', async () => {
    const response = await post(baseUrl, JSON.stringify({ source: 'render', message: 'TypeError: x is not a function' }));
    expect(response.status).toBe(204);
  });

  it('refuses a report whose source is not one the client is allowed to send', async () => {
    const response = await post(baseUrl, JSON.stringify({ source: 'http_4xx', message: 'forbidden' }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as ApiErrorEnvelope;
    expect(body.error.code).toBe('invalid_request');
  });

  it('refuses a report with no message', async () => {
    const response = await post(baseUrl, JSON.stringify({ source: 'render', message: '   ' }));
    expect(response.status).toBe(400);
  });

  it('clips an over-long message instead of writing it whole to the log', async () => {
    const entries = await captureLogs(async () => {
      const response = await post(baseUrl, JSON.stringify({
        source: 'promise',
        message: 'A'.repeat(BROWSER_ERROR_MAX_FIELD_CHARS + 400),
      }));
      await response.text();
    });

    const reportLine = entries.find((entry) => entry.kind === 'browser_error' && entry.source === 'promise');
    if (!reportLine) throw new Error('expected a browser_error log line');
    expect(String(reportLine.message)).toHaveLength(BROWSER_ERROR_MAX_FIELD_CHARS);
  });

  // The report text is attacker-controlled. It reaches the log as a JSON field value, so a
  // newline or a forged key inside it cannot split the line or add a field of its own.
  it('cannot forge log structure through the message', async () => {
    const entries = await captureLogs(async () => {
      const response = await post(baseUrl, JSON.stringify({
        source: 'render',
        message: 'boom"}\n{"level":"error","kind":"forged","message":"admin deleted everything',
      }));
      await response.text();
    });

    expect(entries.some((entry) => entry.kind === 'forged')).toBe(false);
    const reportLine = entries.find((entry) => entry.kind === 'browser_error' && String(entry.message).startsWith('boom'));
    if (!reportLine) throw new Error('expected the forged text to survive as one field value');
    expect(String(reportLine.message)).toContain('forged');
  });
});

describe('browser error ingest, abuse resistance', () => {
  const previousLevel = process.env.LOG_LEVEL;
  beforeAll(() => { process.env.LOG_LEVEL = 'silent'; });
  afterAll(() => {
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
  });

  it('refuses a body larger than the ingest limit without a 500', async () => {
    const { server, baseUrl } = await startApp();
    try {
      const response = await post(baseUrl, JSON.stringify({
        source: 'render',
        message: 'x'.repeat(64 * 1024),
      }));
      expect(response.status).toBe(413);
      const body = (await response.json()) as ApiErrorEnvelope;
      expect(body.error.code).toBe('payload_too_large');
    } finally {
      await stop(server);
    }
  });

  // A fresh app owns a fresh throttle, so this counts against nothing else in the suite.
  it('throttles a client that keeps reporting', async () => {
    const { server, baseUrl } = await startApp();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < BROWSER_ERROR_MAX_PER_WINDOW + 1; i += 1) {
        const response = await post(baseUrl, JSON.stringify({ source: 'render', message: `boom ${i}` }));
        statuses.push(response.status);
        await response.text();
      }

      expect(statuses.slice(0, BROWSER_ERROR_MAX_PER_WINDOW)).toEqual(
        Array<number>(BROWSER_ERROR_MAX_PER_WINDOW).fill(204),
      );
      expect(statuses[BROWSER_ERROR_MAX_PER_WINDOW]).toBe(429);

      const blocked = await post(baseUrl, JSON.stringify({ source: 'render', message: 'still going' }));
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
    } finally {
      await stop(server);
    }
  });
});
