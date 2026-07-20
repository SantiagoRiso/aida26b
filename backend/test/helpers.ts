import fs from 'fs';
import os from 'os';
import path from 'path';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Configurable so concurrent suite runs (parallel agents, parallel CI jobs against the same
// Postgres service) don't fight over one physical database — each caller sets its own name.
// Default matches the historical hardcoded value, so a plain `npm run test:db` with no env is
// unchanged. Validated: this is interpolated into DDL (DROP/CREATE DATABASE) since Postgres
// doesn't accept a database name as a bind parameter.
const TEST_DB_NAME = (() => {
  const name = process.env.TEST_DB_NAME || 'professional_agenda_test';
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error(`TEST_DB_NAME must match [a-zA-Z0-9_]+, got: ${name}`);
  }
  return name;
})();

const connBase = { host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT || '5432') };

// The app role: least-privilege, only the per-table grants the migrations hand out. The server
// under test runs on this so tests exercise the same grants production does.
function envApp() {
  return { ...connBase, user: process.env.DB_USER, password: process.env.DB_PASSWORD };
}

// Superuser: harness-only. Creates/drops the test DB and runs migrations (owner/superuser DDL like
// ALTER DEFAULT PRIVILEGES). Never handed to the app. POSTGRES_SUPERUSER/POSTGRES_SUPERPASS are
// the names used by .env.example and docker-compose.yml.
function envSuper() {
  return {
    ...connBase,
    user: process.env.POSTGRES_SUPERUSER,
    password: process.env.POSTGRES_SUPERPASS,
  };
}

async function terminateConnections(admin: Pool): Promise<void> {
  await admin.query(
    `SELECT pg_terminate_backend(pid)
     FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [TEST_DB_NAME]
  );
}

export async function resetTestDb(): Promise<void> {
  const admin = new Pool({ ...envSuper(), database: 'postgres' });
  try {
    await terminateConnections(admin);
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
    await admin.query(`CREATE DATABASE ${TEST_DB_NAME}`);
  } finally {
    await admin.end();
  }
}

// Drops the run's database once the whole suite finishes (see test/global-setup.ts), so a
// uniquely-named run (TEST_DB_NAME override) doesn't linger as an orphan on the Postgres instance.
export async function dropTestDb(): Promise<void> {
  const admin = new Pool({ ...envSuper(), database: 'postgres' });
  try {
    await terminateConnections(admin);
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
  } finally {
    await admin.end();
  }
}

// Harness pool (superuser): schema setup, migrations, fixture seeding, and direct assertions.
export function makeTestPool(): Pool {
  return new Pool({ ...envSuper(), database: TEST_DB_NAME });
}

// App-role pool (aida26_user): hand this to the server under test so API paths hit real grants.
export function makeAppPool(): Pool {
  return new Pool({ ...envApp(), database: TEST_DB_NAME });
}

export function makeTempMigrationsDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-test-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

export function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
