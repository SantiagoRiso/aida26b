import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../src/db';

type LogEntry = Record<string, string | number>;

function captureLogs(fn: () => void): LogEntry[] {
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
  return lines.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line) as LogEntry);
}

afterAll(async () => {
  await pool.end();
});

describe('pool error handler', () => {
  // Without a listener, EventEmitter re-throws an 'error' event as an uncaught exception —
  // this test proves the handler in db.ts absorbs it into a structured log line instead.
  it('an idle client error is logged instead of crashing the process', () => {
    const logs = captureLogs(() => {
      pool.emit('error', new Error('terminating connection due to administrator command'));
    });

    const entry = logs.find((l) => l.level === 'error');
    expect(entry).toBeTruthy();
    expect(entry?.error).toBe('terminating connection due to administrator command');
  });
});
