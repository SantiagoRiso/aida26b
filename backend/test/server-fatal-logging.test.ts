import { describe, it, expect, afterAll } from 'vitest';
import { logFatal, pool } from '../src/server';

// Only the logging shape is tested here, not the process.on('uncaughtException'/'unhandledRejection')
// registration itself: that registration is gated behind `require.main === module` (same as
// app.listen just below it) and calls process.exit(1) — actually firing it would kill the test
// worker. logFatal is the pure, exported piece of that behavior, so it is what gets covered.
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

describe('logFatal', () => {
  it('logs an Error instance with its kind, message and stack', () => {
    const logs = captureLogs(() => logFatal('uncaughtException', new Error('disk full')));

    const entry = logs.find((l) => l.level === 'error');
    expect(entry).toBeTruthy();
    expect(entry?.kind).toBe('uncaughtException');
    expect(entry?.error).toBe('disk full');
    expect(typeof entry?.stack).toBe('string');
    expect((entry?.stack as string).length).toBeGreaterThan(0);
  });

  it('logs a non-Error rejection reason by coercing it to a string', () => {
    const logs = captureLogs(() => logFatal('unhandledRejection', 'plain string rejection'));

    const entry = logs.find((l) => l.level === 'error');
    expect(entry?.kind).toBe('unhandledRejection');
    expect(entry?.error).toBe('plain string rejection');
  });
});
