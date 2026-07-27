import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import {
  CONSTRAINT_DETAIL_KEYS,
  USER_IDENTITY_CONSTRAINT_DETAIL_KEYS,
  INTENTIONALLY_GENERIC_CONSTRAINTS,
} from '../../shared/src/ssot/domain/constraint-messages';

// Migrations are immutable, so a constraint's name can't be derived from TS — it has to be typed
// once (constraint-messages.ts) and checked against the REAL catalog, not the migration text
// (schema-ssot-drift.test.ts's approach breaks the moment a name is auto-generated or discovered
// at migration time, e.g. ledger_entries_entry_type_check). This guard queries pg_constraint and
// pg_indexes directly so a migration that adds a new UNIQUE/CHECK constraint with no decision in
// constraint-messages.ts (mapped, identity-only, or explicitly intentionally-generic) fails here
// instead of shipping a mystery "Ya existe un registro con esos datos." to a customer.

let pool: Pool;

type LiveConstraint = { name: string; kind: 'unique_constraint' | 'check_constraint' | 'unique_index' };

async function liveConstraints(): Promise<LiveConstraint[]> {
  const { rows } = await pool.query<{ name: string; kind: LiveConstraint['kind'] }>(`
    SELECT conname AS name,
           CASE contype WHEN 'u' THEN 'unique_constraint' ELSE 'check_constraint' END AS kind
    FROM pg_constraint
    WHERE contype IN ('u', 'c')
      AND connamespace::regnamespace::text IN ('public', 'auth')

    UNION ALL

    SELECT indexname AS name, 'unique_index' AS kind
    FROM pg_indexes
    WHERE schemaname IN ('public', 'auth')
      AND indexdef ILIKE '%UNIQUE%'
      AND indexname NOT LIKE '%_pkey'
      -- Every CREATE UNIQUE INDEX also backs a pg_constraint row when declared via
      -- ADD CONSTRAINT ... UNIQUE; only count the ones with no constraint counterpart so a name
      -- isn't asserted twice.
      AND indexname NOT IN (SELECT conname FROM pg_constraint)
  `);
  return rows;
}

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
}, 30000);

afterAll(async () => {
  await pool.end();
});

describe('every live UNIQUE/CHECK constraint has an explicit detail-key decision', () => {
  it('no constraint is undeclared (mapped, identity-only, or intentionally-generic)', async () => {
    const known = new Set([
      ...Object.keys(CONSTRAINT_DETAIL_KEYS),
      ...Object.keys(USER_IDENTITY_CONSTRAINT_DETAIL_KEYS),
      ...INTENTIONALLY_GENERIC_CONSTRAINTS,
    ]);
    const live = await liveConstraints();
    const undeclared = live.filter((c) => !known.has(c.name)).map((c) => `${c.name} (${c.kind})`);
    expect(undeclared, `add each to CONSTRAINT_DETAIL_KEYS, USER_IDENTITY_CONSTRAINT_DETAIL_KEYS, or INTENTIONALLY_GENERIC_CONSTRAINTS in shared/src/ssot/domain/constraint-messages.ts:\n  ${undeclared.join('\n  ')}`).toEqual([]);
  });

  it('no declared name is stale (renamed/dropped in a later migration)', async () => {
    const live = new Set((await liveConstraints()).map((c) => c.name));
    const declared = [
      ...Object.keys(CONSTRAINT_DETAIL_KEYS),
      ...Object.keys(USER_IDENTITY_CONSTRAINT_DETAIL_KEYS),
      ...INTENTIONALLY_GENERIC_CONSTRAINTS,
    ];
    const stale = declared.filter((name) => !live.has(name));
    expect(stale, `these names no longer exist in the live schema: ${stale.join(', ')}`).toEqual([]);
  });

  it('the three buckets are mutually exclusive (no name double-booked)', () => {
    const mapped = Object.keys(CONSTRAINT_DETAIL_KEYS);
    const identity = Object.keys(USER_IDENTITY_CONSTRAINT_DETAIL_KEYS);
    const generic = INTENTIONALLY_GENERIC_CONSTRAINTS;
    const overlap = [...mapped, ...identity].filter((name) => generic.includes(name));
    expect(overlap).toEqual([]);
    const mappedAndIdentity = mapped.filter((name) => identity.includes(name));
    expect(mappedAndIdentity).toEqual([]);
  });
});
