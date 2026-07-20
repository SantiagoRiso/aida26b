import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { getTableKeys, tableOf } from '../../shared/src/utils/utils';
import type { TableKey } from '../../shared/src/ssot/derived';

// schema-ssot-drift.test.ts guards SSOT constants against migration-file *text* (CHECK clauses,
// defaults, the users_directory view's SELECT list) — it never touches a live database, and its
// view check only covers users/clients/professionals. Nothing previously compared an arbitrary
// table descriptor's columns against the actual live catalog, so a descriptor could name a column
// that doesn't exist (or disagree on nullability) and nothing would fail until a request hit it in
// production. This file closes that gap generically, for every table the SSOT declares.

let pool: Pool;

type PhysicalColumn = { isNullable: boolean; hasDefault: boolean };
type PhysicalTable = { schema: string; table: string; isView: boolean; columns: Map<string, PhysicalColumn> };

// Resolves the same SQL target the generic engine would use: `sqlTable` when the descriptor sets
// one (a real table for logical entities like clients/professionals, or — for the read-only users
// entity — the secret-free view itself, since generic reads for `users` hit it directly), else the
// descriptor key unqualified. The schema for an unqualified name is discovered from the live
// catalog rather than assumed to be `public`, since app tables also live under `auth`
// (auth.sessions has no sqlTable override yet isn't in `public`).
async function resolvePhysicalTable(key: string, sqlTable: string | undefined): Promise<PhysicalTable | null> {
  const raw = sqlTable ?? key;
  let schema: string;
  let table: string;
  if (raw.includes('.')) {
    [schema, table] = raw.split('.');
  } else {
    const found = await pool.query<{ table_schema: string }>(
      `SELECT table_schema FROM information_schema.tables
       WHERE table_name = $1 AND table_schema IN ('public', 'auth')`,
      [raw],
    );
    if (found.rows.length !== 1) return null;
    schema = found.rows[0].table_schema;
    table = raw;
  }

  const typeRes = await pool.query<{ table_type: string }>(
    `SELECT table_type FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
    [schema, table],
  );
  if (typeRes.rows.length === 0) return null;

  const colRes = await pool.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
    `SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
    [schema, table],
  );
  const columns = new Map(
    colRes.rows.map((r) => [r.column_name, { isNullable: r.is_nullable === 'YES', hasDefault: r.column_default !== null }]),
  );
  return { schema, table, isView: typeRes.rows[0].table_type === 'VIEW', columns };
}

const tableKeys: TableKey[] = getTableKeys();

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
}, 30000);

afterAll(async () => {
  await pool.end();
});

describe('SSOT ↔ live-schema column drift guard', () => {
  it.each(tableKeys)('%s: descriptor columns exist physically, with agreeing nullability', async (key) => {
    const desc = tableOf(key);
    const physical = await resolvePhysicalTable(key, desc.sqlTable);
    expect(physical, `no physical table/view resolvable for '${key}' (target: ${desc.sqlTable ?? key})`).not.toBeNull();
    if (!physical) return;

    const missing: string[] = [];
    const nullabilityMismatches: string[] = [];

    for (const [colName, colDef] of Object.entries(desc.columns)) {
      const physCol = physical.columns.get(colName);
      if (!physCol) {
        missing.push(colName);
        continue;
      }

      // Server-stamped/computed columns (id, business_id): a validator's required/nullable
      // notion describes what the API accepts from a client, not the DB shape — these are never
      // taken from the request body, so the DB is free to be NOT NULL with a default (id) or
      // NOT NULL populated by the write path itself (business_id). Nothing to compare here.
      if (colDef.derivable) continue;

      // Postgres never propagates a source table's NOT NULL onto a plain pass-through view
      // column (verified empirically: a NOT NULL base column reads back as is_nullable='YES'
      // through any view over it) — so nullability is only meaningful to assert against a real
      // base table. `users` resolves to auth.users_directory (a view); its required columns are
      // enforced on the real auth.users table, exercised there via the clients/professionals
      // descriptors (sqlTable: 'auth.users') and scheduler-schema.db.test.ts's direct column checks.
      if (physical.isView) continue;

      const validator = colDef.validator;
      // "nullable" in the SSOT means "may be omitted from a create/update body", not literally
      // "the DB value may be NULL" — a NOT NULL column with a DEFAULT (min_booking_days DEFAULT
      // 0, schedule_exceptions.is_unavailable DEFAULT true) is legitimately omittable even though
      // it can never actually be NULL. Only flag it when omitting the column would genuinely fail:
      // NOT NULL with no default to fall back on.
      if (validator?.nullable === true && !physCol.isNullable && !physCol.hasDefault) {
        nullabilityMismatches.push(`${colName}: descriptor allows omitting/null, DB column is NOT NULL with no default`);
      } else if (validator?.required === true && physCol.isNullable) {
        nullabilityMismatches.push(`${colName}: descriptor requires a value, DB column allows NULL`);
      }
    }

    expect(missing, `descriptor columns absent from ${physical.schema}.${physical.table}: ${missing.join(', ')}`).toEqual([]);
    expect(nullabilityMismatches, `nullability drift on ${physical.schema}.${physical.table}:\n  ${nullabilityMismatches.join('\n  ')}`).toEqual([]);
  });

  // The reverse direction — a physical column with no descriptor counterpart — is deliberately
  // not asserted. The SSOT omits secrets by design (people.ts: "Secrets are deliberately absent
  // from the SSOT" — password_hash/password_salt/token_hash) and never models backend-only
  // bookkeeping (created_at/updated_at, soft-delete columns, which are already named separately
  // via the `softDelete` descriptor field). Asserting "no extra physical columns" would just
  // police that intentional omission and force either a churny allowlist or constant false
  // failures. It's still useful to see, so it's logged, not asserted.
  it('reports (non-failing) physical columns absent from their descriptor, for visibility', async () => {
    const report: string[] = [];
    for (const key of tableKeys) {
      const desc = tableOf(key);
      const physical = await resolvePhysicalTable(key, desc.sqlTable);
      if (!physical) continue;
      const extra = [...physical.columns.keys()].filter((c) => !(c in desc.columns));
      if (extra.length > 0) report.push(`${key} -> ${physical.schema}.${physical.table}: ${extra.join(', ')}`);
    }
    console.log(`[schema-column-drift] physical-only columns (expected: secrets, timestamps, soft-delete bookkeeping):\n${report.join('\n')}`);
    expect(report.length).toBeGreaterThanOrEqual(0);
  });
});
