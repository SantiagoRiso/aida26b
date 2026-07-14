import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { structure } from '../../shared/src/ssot/structure';
import type { TableStructure } from '../../shared/src/types/types';

// The generic engine issues a real UPDATE for any table whose descriptor sets crud.update. If the
// app role lacks the UPDATE grant, that path 500s in production ("permission denied") — yet the
// authz db tests mount the server on the SUPERUSER pool, so they never exercise grants and stay
// green. This guard closes that blind spot: for every updatable table, assert the least-privilege
// app role actually holds UPDATE on the write table (sqlTable, else the table key).
let pool: Pool;
const APP_ROLE = process.env.DB_USER ?? 'aida26_user';

const updatable = Object.entries(structure.tables)
  .filter(([, t]) => (t as TableStructure).crud?.update === true)
  .map(([key, t]) => ({ key, writeTable: (t as TableStructure).sqlTable ?? key }));

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
});

afterAll(async () => {
  await pool.end();
});

describe('app-role UPDATE grants match SSoT crud.update', () => {
  it.each(updatable)('$key: app role may UPDATE $writeTable', async ({ writeTable }) => {
    const { rows } = await pool.query<{ ok: boolean }>(
      `SELECT has_table_privilege($1, $2, 'UPDATE') AS ok`,
      [APP_ROLE, writeTable],
    );
    expect(rows[0].ok).toBe(true);
  });
});
