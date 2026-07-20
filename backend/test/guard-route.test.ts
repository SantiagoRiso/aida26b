import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { guardRoute, guardMiddleware } from '../src/helpers';
import { DbError } from '../src/db/errors';
import { httpError } from '../src/errors';

type Envelope = { success: boolean; error: { code: string; message: string } };
type LogEntry = Record<string, string | number>;

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as Envelope | undefined,
    headersSent: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: Envelope) {
      res.body = payload;
      res.headersSent = true;
      return res;
    },
  };
  return res;
}

// Captures logger.error's stdout writes instead of stubbing console.error — helpers.ts now
// routes unhandled errors through the structured logger, not console.
async function captureLogs(fn: () => Promise<unknown>): Promise<LogEntry[]> {
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
  return lines.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line) as LogEntry);
}

const req = { method: 'GET', path: '/api/audit' } as Request;

describe('async handler crash net', () => {
  it('a rejecting handler responds 500 with the standard envelope and logs the failure with its reqId', async () => {
    const res = fakeRes();
    const reqWithId = { method: 'GET', path: '/api/audit', reqId: 'req-abc-123' } as Request;
    const handler = guardRoute(async () => {
      throw new Error('permission denied for table audit_events');
    });

    // The wrapped handler must settle without rejecting — a rejection here is
    // exactly the unhandled-rejection process kill this guard exists to prevent.
    const logs = await captureLogs(() =>
      Promise.resolve(handler(reqWithId, res as unknown as Response, () => {})),
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'internal_error', message: 'Internal server error' },
    });
    const entry = logs.find((l) => l.level === 'error');
    expect(entry).toBeTruthy();
    expect(entry?.reqId).toBe('req-abc-123');
    expect(entry?.method).toBe('GET');
    expect(entry?.error).toBe('permission denied for table audit_events');
  });

  it('falls back to reqId "unknown" when the handler runs outside requestLogger', async () => {
    const res = fakeRes();
    const handler = guardRoute(async () => {
      throw new Error('boom');
    });

    const logs = await captureLogs(() =>
      Promise.resolve(handler(req, res as unknown as Response, () => {})),
    );

    const entry = logs.find((l) => l.level === 'error');
    expect(entry?.reqId).toBe('unknown');
  });

  it('a rejecting middleware responds 500, logs the failure, and never calls next', async () => {
    const res = fakeRes();
    const next = vi.fn();
    const middleware = guardMiddleware(async () => {
      throw new Error('connection refused');
    });

    const logs = await captureLogs(() =>
      Promise.resolve(middleware(req, res as unknown as Response, next)),
    );

    expect(res.statusCode).toBe(500);
    expect(next).not.toHaveBeenCalled();
    const entry = logs.find((l) => l.level === 'error');
    expect(entry).toBeTruthy();
    expect(entry?.error).toBe('connection refused');
  });

  it('a rejection after the response was already sent does not double-send', async () => {
    const res = fakeRes();
    const handler = guardRoute(async (_req, r) => {
      r.status(200).json({ success: true, error: { code: '', message: '' } });
      throw new Error('late failure');
    });

    await captureLogs(() =>
      Promise.resolve(handler(req, res as unknown as Response, () => {})),
    );

    expect(res.statusCode).toBe(200);
  });

  it('maps a DbError unique-violation (23505) to 409 without logging', async () => {
    const res = fakeRes();
    const handler = guardRoute(async () => {
      throw new DbError('duplicate key value violates unique constraint', '23505');
    });

    const logs = await captureLogs(() =>
      Promise.resolve(handler(req, res as unknown as Response, () => {})),
    );

    expect(res.statusCode).toBe(409);
    expect(res.body?.error.code).toBe('conflict');
    expect(logs.filter((l) => l.level === 'error')).toHaveLength(0);
  });

  it('a structured {status} error thrown from middleware maps to its declared status and never calls next', async () => {
    const res = fakeRes();
    const next = vi.fn();
    const middleware = guardMiddleware(async () => {
      throw httpError(403, 'forbidden', 'Not allowed');
    });

    const logs = await captureLogs(() =>
      Promise.resolve(middleware(req, res as unknown as Response, next)),
    );

    expect(res.statusCode).toBe(403);
    expect(res.body?.error.code).toBe('forbidden');
    expect(next).not.toHaveBeenCalled();
    expect(logs.filter((l) => l.level === 'error')).toHaveLength(0);
  });

  it('an unmapped DbError still responds 500 and logs', async () => {
    const res = fakeRes();
    const handler = guardRoute(async () => {
      throw new DbError('deadlock detected', '40P01');
    });

    const logs = await captureLogs(() =>
      Promise.resolve(handler(req, res as unknown as Response, () => {})),
    );

    expect(res.statusCode).toBe(500);
    expect(logs.filter((l) => l.level === 'error')).toHaveLength(1);
  });
});
