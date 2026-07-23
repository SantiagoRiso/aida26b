import { test, expect } from 'vitest';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { runMigrations } from '../src/migrate';
import { resetTestDb, makeTestPool } from './helpers';

// A17: statement/lock/idle-in-transaction timeouts are set at the role level, scoped IN DATABASE
// so concurrent migration runs against different databases (this suite's parallel *.db.test.ts
// files, each on their own reset database; a test database vs the real one) never race on the
// same pg_authid row. That means the setting lives in pg_db_role_setting (role, database) rather
// than the simpler pg_roles.rolconfig — asked for directly here so this fails if the applied
// migration's role name, scoping, or GUC values ever drift from what's asserted below. Runs the
// real migrations directory (the same pattern every other full-schema *.db.test.ts uses) rather
// than a synthetic copy.
async function roleConfigForCurrentDb(pool: ReturnType<typeof makeTestPool>, role: string): Promise<string[]> {
  const r = await pool.query<{ setconfig: string[] | null }>(
    `SELECT s.setconfig
       FROM pg_db_role_setting s
       JOIN pg_roles r ON r.oid = s.setrole
      WHERE r.rolname = $1
        AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    [role]
  );
  return r.rows[0]?.setconfig ?? [];
}

test('the app role gets bounded statement/lock/idle-in-transaction timeouts, scoped to this database', async () => {
  await resetTestDb();
  const pool = makeTestPool();
  try {
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
    const config = await roleConfigForCurrentDb(pool, 'aida26_user');

    expect(config).toContain('statement_timeout=15s');
    expect(config).toContain('lock_timeout=5s');
    expect(config).toContain('idle_in_transaction_session_timeout=30s');
  } finally {
    await pool.end();
  }
});

test('the owner/migration role is not statement- or lock-bounded, only idle-in-transaction bounded', async () => {
  await resetTestDb();
  const pool = makeTestPool();
  try {
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
    const config = await roleConfigForCurrentDb(pool, 'aida26_owner');

    expect(config).toContain('idle_in_transaction_session_timeout=5min');
    expect(config.some((c) => c.startsWith('statement_timeout='))).toBe(false);
    expect(config.some((c) => c.startsWith('lock_timeout='))).toBe(false);
  } finally {
    await pool.end();
  }
});
