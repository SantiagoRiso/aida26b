import { describe, test, expect } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { toRecord, withTransaction } from '../src/db/core';

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
  function fakeClient(calls: string[]): PoolClient {
    return {
      query: (sql: string) => {
        calls.push(sql);
        return Promise.resolve({ rows: [] });
      },
      release: () => {
        calls.push('RELEASE');
      },
      // eslint-disable-next-line no-restricted-syntax -- partial mock of pg's PoolClient — implementing its full driver interface isn't practical for a test double
    } as unknown as PoolClient;
  }

  test('commits and releases on success', async () => {
    const calls: string[] = [];
    // eslint-disable-next-line no-restricted-syntax -- partial mock of pg's Pool — implementing its full driver interface isn't practical for a test double
    const pool = { connect: () => Promise.resolve(fakeClient(calls)) } as unknown as Pool;

    const result = await withTransaction(pool, async () => 42);

    expect(result).toBe(42);
    expect(calls).toEqual(['BEGIN', 'COMMIT', 'RELEASE']);
  });

  test('rolls back, releases, and rethrows the original error on failure', async () => {
    const calls: string[] = [];
    // eslint-disable-next-line no-restricted-syntax -- partial mock of pg's Pool — implementing its full driver interface isn't practical for a test double
    const pool = { connect: () => Promise.resolve(fakeClient(calls)) } as unknown as Pool;

    await expect(
      withTransaction(pool, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(calls).toEqual(['BEGIN', 'ROLLBACK', 'RELEASE']);
  });

  test('preserves a structured status error thrown inside the transaction', async () => {
    const calls: string[] = [];
    // eslint-disable-next-line no-restricted-syntax -- partial mock of pg's Pool — implementing its full driver interface isn't practical for a test double
    const pool = { connect: () => Promise.resolve(fakeClient(calls)) } as unknown as Pool;

    await expect(
      withTransaction(pool, async () => {
        throw { status: 404, code: 'not_found', message: 'owner gone' };
      }),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });

    expect(calls).toEqual(['BEGIN', 'ROLLBACK', 'RELEASE']);
  });
});
