import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { seedDemo } from '../src/seed-demo';
import { resetTestDb, makeTestPool } from './helpers';

// SC5 item 7: a fresh-schema migration + demo-seed load must succeed on an empty DB.
// Also proves append-only idempotency — ledger_entries and audit_events counts are stable
// across a re-run because both are guarded by natural-key WHERE NOT EXISTS.

let pool: Pool;

async function count(table: string): Promise<number> {
  const r = await pool.query<{ count: string }>(`SELECT COUNT(*)::int AS count FROM ${table}`);
  return Number(r.rows[0].count);
}

// Counts captured after the first seed, compared after the second.
let afterFirst: Record<string, number> = {};
let afterSecond: Record<string, number> = {};

const CORE_TABLES = [
  'businesses',
  'auth.users',
  'services',
  'resources',
  'schedules',
  'appointments',
  'ledger_entries',
  'audit_events',
  'calendar_grants',
];

async function snapshot(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of CORE_TABLES) out[t] = await count(t);
  return out;
}

// Two seed runs hash ~42 passwords each (scrypt) — widen past the 10s default hook timeout.
beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  await seedDemo(pool);
  afterFirst = await snapshot();

  // Re-run to prove idempotency across every table, including the append-only pair.
  await seedDemo(pool);
  afterSecond = await snapshot();
}, 60_000);

afterAll(async () => {
  await pool.end();
});

describe('fresh-schema migration + demo-seed load (SC5 item 7)', () => {
  it('loads seedDemo without error and populates every core table', async () => {
    for (const t of CORE_TABLES) {
      expect(afterFirst[t], `${t} should be non-empty after seed`).toBeGreaterThan(0);
    }
  });

  it('keeps exactly one business (single active business)', () => {
    expect(afterFirst['businesses']).toBe(1);
    expect(afterSecond['businesses']).toBe(1);
  });

  it('is idempotent across every core table on a second run', () => {
    for (const t of CORE_TABLES) {
      expect(afterSecond[t], `${t} count must be stable across a re-run`).toBe(afterFirst[t]);
    }
  });

  it('keeps append-only ledger_entries and audit_events counts identical across a re-run', () => {
    // The immutability triggers reject UPDATE/DELETE, so idempotency here relies on the
    // natural-key existence guards in the seed rather than ON CONFLICT.
    expect(afterSecond['ledger_entries']).toBe(afterFirst['ledger_entries']);
    expect(afterSecond['audit_events']).toBe(afterFirst['audit_events']);
  });
});
