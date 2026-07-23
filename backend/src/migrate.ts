import dotenv from 'dotenv';
import { Pool, PoolClient } from 'pg';
import { createOwnerPool } from './db';
import { DEFAULT_MIGRATIONS_DIR, listMigrationFiles, readMigration } from './migration-files';

// Every other CLI entry point (server.ts, seed-*.ts) loads .env; migrate.ts must too,
// otherwise `npm run migrate` fails standalone with "client password must be a string"
// even though the same credentials work fine wherever dotenv has already run (test harness).
dotenv.config();

// Same advisory-lock key Flyway uses by convention — coexists with any
// external migration tool that follows the same convention.
const LOCK_KEY = 7910;

// Assigning a real transaction id up front gives the transaction an identity that survives no
// matter what the migration body does; a migration that commits lands in a different one.
async function currentTxId(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    'SELECT pg_current_xact_id()::text AS id'
  );
  return rows[0].id;
}

// Null outside a transaction block, since the implicit transaction wrapping this SELECT writes
// nothing and so is never assigned an id.
async function currentTxIdIfAssigned(client: PoolClient): Promise<string | null> {
  const { rows } = await client.query<{ id: string | null }>(
    'SELECT pg_current_xact_id_if_assigned()::text AS id'
  );
  return rows[0].id;
}

export async function runMigrations(pool: Pool, dir: string): Promise<number> {
  const client = await pool.connect();
  let appliedCount = 0;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          filename   TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          checksum   TEXT NOT NULL
        );
      `);

      const files = listMigrationFiles(dir);
      const { rows } = await client.query<{ filename: string; checksum: string }>(
        'SELECT filename, checksum FROM schema_migrations'
      );
      const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

      for (const file of files) {
        const { sql, checksum } = readMigration(dir, file);
        const recorded = applied.get(file);

        if (recorded !== undefined) {
          if (recorded !== checksum) {
            throw new Error(
              `Migration "${file}" was modified after being applied.\n` +
                `Applied migrations are immutable — write a new migration that undoes/adjusts the change instead.`
            );
          }
          continue;
        }

        await client.query('BEGIN');
        try {
          const txId = await currentTxId(client);
          await client.query(sql);
          // The file must not have ended the runner's transaction: everything after that point,
          // including the schema_migrations row below, would commit without rollback protection.
          if ((await currentTxIdIfAssigned(client)) !== txId) {
            throw new Error(
              'the file ended the runner transaction (a COMMIT/ROLLBACK of its own, ' +
                'or a procedure that commits). Migrations must not manage transactions.'
            );
          }
          await client.query(
            'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
            [file, checksum]
          );
          await client.query('COMMIT');
          appliedCount++;
        } catch (err) {
          await client.query('ROLLBACK');
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`Migration "${file}" failed: ${message}`);
        }
      }

      return appliedCount;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

async function cli(): Promise<void> {
  const pool = createOwnerPool();
  try {
    const applied = await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
    console.log(DEFAULT_MIGRATIONS_DIR);
    if (applied === 0) {
      console.log('No pending migrations.');
    } else {
      console.log(`Applied ${applied} migration${applied === 1 ? '' : 's'}.`);
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  cli().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
