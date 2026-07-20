import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import type { Pool } from 'pg';
import { createAuditWriter } from '../src/audit';

type LogEntry = Record<string, string | number>;

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

// Pool stub whose every query rejects, standing in for a broken DB connection —
// override.actorId/businessId below skip the getUserBusinessId lookup so insertAuditEvent's
// query() is the only call made and the only thing that can fail.
function throwingPool(message: string): Pool {
  return {
    query: async () => {
      throw new Error(message);
    },
  } as unknown as Pool;
}

describe('audit writer — best-effort failure visibility', () => {
  it('never rejects when the underlying insert fails', async () => {
    const audit = createAuditWriter(throwingPool('connection terminated unexpectedly'));
    const req = {} as Request;

    // Wrapped in captureLogs purely to keep the expected error log out of the test run's own
    // stdout — the assertion here is only about the promise settling, not what got logged.
    await captureLogs(() =>
      expect(
        audit(req, 'appointment_scheduled', 'success', {}, { actorId: 1, businessId: 2 }),
      ).resolves.toBeUndefined(),
    );
  });

  it('logs the swallowed failure with the request id, event type and outcome', async () => {
    const audit = createAuditWriter(throwingPool('connection terminated unexpectedly'));
    const req = { reqId: 'req-audit-1' } as Request;

    const logs = await captureLogs(() =>
      audit(req, 'appointment_scheduled', 'success', {}, { actorId: 1, businessId: 2 }),
    );

    const entry = logs.find((l) => l.level === 'error');
    expect(entry).toBeTruthy();
    expect(entry?.reqId).toBe('req-audit-1');
    expect(entry?.eventType).toBe('appointment_scheduled');
    expect(entry?.outcome).toBe('success');
    expect(entry?.error).toBe('connection terminated unexpectedly');
  });

  it('falls back to reqId "unknown" when no request id is attached', async () => {
    const audit = createAuditWriter(throwingPool('boom'));
    const req = {} as Request;

    const logs = await captureLogs(() =>
      audit(req, 'appointment_scheduled', 'success', {}, { actorId: 1, businessId: 2 }),
    );

    const entry = logs.find((l) => l.level === 'error');
    expect(entry?.reqId).toBe('unknown');
  });
});
