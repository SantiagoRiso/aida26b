import { describe, test, expect } from 'vitest';
import { toRecord, withTransaction, type TransactionClient, type TransactionPool } from '../src/db/core';

describe('toRecord — SSoT-driven coercion', () => {
  test('coerces number and date columns; leaves string columns and drops unknown keys', () => {
    const r = toRecord('appointments', {
      professional_user_id: '10',            // SSoT type 'string' → unchanged
      duration_minutes: '30',                // SSoT type 'number' → Number
      starts_at: '2026-07-01T13:00:00.000Z', // SSoT type 'date' → Date
      not_a_column: 'ignored',               // not in SSoT → dropped
    });

    expect(r.professional_user_id).toBe('10');
    expect(r.duration_minutes).toBe(30);
    expect(r.starts_at).toBeInstanceOf(Date);
    expect(r.starts_at.toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(r).not.toHaveProperty('not_a_column');
  });

  test('preserves nulls', () => {
    const r = toRecord('appointments', { duration_minutes: null });
    expect(r.duration_minutes).toBeNull();
  });
});

describe('withTransaction — lifecycle', () => {
  function fakeClient(calls: string[]): TransactionClient {
    return {
      query: (sql: string) => {
        calls.push(sql);
        return Promise.resolve({ rows: [] });
      },
      release: () => {
        calls.push('RELEASE');
      },
    };
  }

  function fakePool(calls: string[]): TransactionPool {
    return { connect: () => Promise.resolve(fakeClient(calls)) };
  }

  test('commits and releases on success', async () => {
    const calls: string[] = [];
    const pool = fakePool(calls);

    const result = await withTransaction(pool, async () => 42);

    expect(result).toBe(42);
    expect(calls).toEqual(['BEGIN', 'COMMIT', 'RELEASE']);
  });

  test('rolls back, releases, and rethrows the original error on failure', async () => {
    const calls: string[] = [];
    const pool = fakePool(calls);

    await expect(
      withTransaction(pool, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(calls).toEqual(['BEGIN', 'ROLLBACK', 'RELEASE']);
  });

  test('preserves a structured status error thrown inside the transaction', async () => {
    const calls: string[] = [];
    const pool = fakePool(calls);

    await expect(
      withTransaction(pool, async () => {
        throw { status: 404, code: 'not_found', message: 'owner gone' };
      }),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });

    expect(calls).toEqual(['BEGIN', 'ROLLBACK', 'RELEASE']);
  });
});
