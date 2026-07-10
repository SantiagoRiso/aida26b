import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { guardRoute, guardMiddleware } from '../src/helpers';

type Envelope = { success: boolean; error: { code: string; message: string } };

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

const req = { method: 'GET', path: '/api/audit' } as Request;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('async handler crash net', () => {
  it('a rejecting handler responds 500 with the standard envelope instead of crashing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = fakeRes();
    const handler = guardRoute(async () => {
      throw new Error('permission denied for table audit_events');
    });

    // The wrapped handler must settle without rejecting — a rejection here is
    // exactly the unhandled-rejection process kill this guard exists to prevent.
    await expect(
      Promise.resolve(handler(req, res as unknown as Response, () => {})),
    ).resolves.not.toThrow();

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'internal_error', message: 'Internal server error' },
    });
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it('a rejecting middleware responds 500 and never calls next', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = fakeRes();
    const next = vi.fn();
    const middleware = guardMiddleware(async () => {
      throw new Error('connection refused');
    });

    await expect(
      Promise.resolve(middleware(req, res as unknown as Response, next)),
    ).resolves.not.toThrow();

    expect(res.statusCode).toBe(500);
    expect(next).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it('a rejection after the response was already sent does not double-send', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = fakeRes();
    const handler = guardRoute(async (_req, r) => {
      r.status(200).json({ success: true, error: { code: '', message: '' } });
      throw new Error('late failure');
    });

    await Promise.resolve(handler(req, res as unknown as Response, () => {}));

    expect(res.statusCode).toBe(200);
  });
});
