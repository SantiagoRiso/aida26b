import fs from 'fs';
import os from 'os';
import path from 'path';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import { markAuditStrict } from '../src/audit';

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

// DROP/CREATE DATABASE take exclusive locks on the shared catalog, so concurrent suite runs — even
// on distinct database names — can lose that race and report a failure that says nothing about the
// code under test. Only states that a later attempt can plausibly win are retried: a bad password,
// a missing role, an unreachable host or a syntax error is a real failure and must surface on the
// first attempt rather than after a minute of pointless backoff.
const TRANSIENT_SQLSTATES = new Set([
  '55006', // object_in_use — "database is being accessed by other users"
  '55P03', // lock_not_available
  '57014', // query_canceled — a statement/lock timeout fired
  '57P01', // admin_shutdown — "terminating connection due to administrator command"
  '57P03', // cannot_connect_now — server still coming up
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53300', // too_many_connections
]);

// Socket-level failures the driver reports without a SQLSTATE. ECONNREFUSED/ENOTFOUND are absent on
// purpose: those mean wrong host/port or a server that isn't running, which retrying cannot fix.
const TRANSIENT_SOCKET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT']);

// pg reports a backend that vanished mid-statement as a plain Error with no code at all.
const TRANSIENT_MESSAGES = [
  /connection terminated/i,
  /connection error/i,
  /server closed the connection/i,
  /timeout exceeded when trying to connect/i,
];

const RESET_ATTEMPTS = 6;
const RESET_BASE_DELAY_MS = 120;

function isTransientCatalogError(
  // eslint-disable-next-line no-restricted-syntax -- catch-boundary: the pg driver throws an unverified error shape
  error: unknown,
): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code;
  if (typeof code === 'string') {
    return TRANSIENT_SQLSTATES.has(code) || TRANSIENT_SOCKET_CODES.has(code);
  }
  return TRANSIENT_MESSAGES.some((pattern) => pattern.test(error.message));
}

// Each attempt reruns the whole terminate/drop/create unit on a fresh admin pool: the sequence is
// idempotent (DROP IF EXISTS), and a pool whose backend was terminated cannot be reused.
async function withCatalogRetry(step: (admin: Pool) => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const admin = new Pool({ ...envSuper(), database: 'postgres' });
    // An idle client killed by a competing pg_terminate_backend emits on the pool; unhandled, that
    // aborts the run instead of surfacing as the retryable error the next query already reports.
    admin.on('error', () => {});
    try {
      await step(admin);
      return;
    } catch (error) {
      if (attempt >= RESET_ATTEMPTS || !isTransientCatalogError(error)) throw error;
      const backoff = RESET_BASE_DELAY_MS * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, backoff + Math.random() * RESET_BASE_DELAY_MS));
    } finally {
      // Never let a teardown hiccup replace the error that actually explains the failure.
      await admin.end().catch(() => {});
    }
  }
}

export function resetTestDb(): Promise<void> {
  return withCatalogRetry(async (admin) => {
    await terminateConnections(admin);
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
    await admin.query(`CREATE DATABASE ${TEST_DB_NAME}`);
  });
}

// Drops the run's database once the whole suite finishes (see test/global-setup.ts), so a
// uniquely-named run (TEST_DB_NAME override) doesn't linger as an orphan on the Postgres instance.
export function dropTestDb(): Promise<void> {
  return withCatalogRetry(async (admin) => {
    await terminateConnections(admin);
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
  });
}

// Harness pool (superuser): schema setup, migrations, fixture seeding, and direct assertions.
// Marked audit-strict: a db test whose fixture audits with an actor id that isn't a real
// auth.users row must fail loudly, not emit a swallowed error line (see src/audit.ts).
export function makeTestPool(): Pool {
  const pool = new Pool({ ...envSuper(), database: TEST_DB_NAME });
  markAuditStrict(pool);
  return pool;
}

// App-role pool (aida26_user): hand this to the server under test so API paths hit real grants.
// Marked audit-strict for the same reason as makeTestPool.
export function makeAppPool(): Pool {
  const pool = new Pool({ ...envApp(), database: TEST_DB_NAME });
  markAuditStrict(pool);
  return pool;
}

export const APP_ROLE = process.env.DB_USER ?? 'aida26_user';

// Every grant assertion in the suite is vacuous when the app role is a superuser or owns the
// migrated tables: both hold every privilege implicitly, so the check passes without proving
// anything. Throw rather than skip — a skipped grant check reports green, and green is exactly
// what lets a lost GRANT (or a lost withholding) ship unnoticed.
export async function assertAppRoleIsLeastPrivilege(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ rolsuper: boolean }>(
    `SELECT rolsuper FROM pg_roles WHERE rolname = $1`,
    [APP_ROLE],
  );
  if (rows.length === 0) {
    throw new Error(
      `App role '${APP_ROLE}' (DB_USER) does not exist. The grant assertions cannot run.`,
    );
  }
  if (rows[0].rolsuper) {
    throw new Error(
      `App role '${APP_ROLE}' (DB_USER) is a SUPERUSER, so it bypasses every privilege check and ` +
        `the grant assertions would pass without proving anything. Point DB_USER at the ` +
        `least-privilege application role (a two-role setup, as created by database/bootstrap.sh), ` +
        `distinct from POSTGRES_SUPERUSER and DB_OWNER_USER.`,
    );
  }

  const { rows: owned } = await pool.query<{ table_name: string }>(
    `SELECT schemaname || '.' || tablename AS table_name
       FROM pg_tables
      WHERE tableowner = $1 AND schemaname IN ('public', 'auth')
      ORDER BY 1`,
    [APP_ROLE],
  );
  if (owned.length > 0) {
    throw new Error(
      `App role '${APP_ROLE}' (DB_USER) owns migrated tables (${owned
        .map((r) => r.table_name)
        .join(', ')}), and a table owner holds every privilege implicitly. Migrations must run as ` +
        `the schema-owner role (DB_OWNER_USER), never as the application role.`,
    );
  }
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
