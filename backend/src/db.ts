import { Pool } from 'pg';
import type { Queryable } from './db/core';
import dotenv from 'dotenv';
import { logger } from './logger';

dotenv.config();

const connection = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
};

// Pool sizing is explicit rather than left to pg's defaults, so the limits this app runs under are
// documented in one place instead of implied by whatever the driver ships with:
// - max 10: this app is a single-tenant-per-request CRUD API, not a fan-out worker; 10 concurrent
//   DB clients comfortably covers expected request concurrency at this scale.
// - connectionTimeoutMillis 5000: covers both establishing a new physical connection AND, in
//   node-postgres, waiting for a client once the pool is at `max` — without it, a request made once
//   all 10 clients are checked out queues forever instead of failing fast. 5s gives a legitimate
//   burst room to drain before a caller gives up and retries.
// Statement/lock/idle-in-transaction timeouts are set at the role level (see the
// role_session_timeouts migration) rather than here, so they apply to every connection under that
// role — including ones opened outside this pool (a psql session, a future worker) — not just this
// process's.
export const pool = new Pool({
  ...connection,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 10,
  connectionTimeoutMillis: 5000,
});

// An idle client can error independently of any in-flight query (e.g. the backend closing the
// connection). Without a handler here, pg's EventEmitter has no listener and Node treats that as
// an uncaught error — this keeps it a visible log line instead of a crash or a silent drop.
pool.on('error', (error) => {
  logger.error({ msg: 'idle database client error', error: error.message });
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required: migrations and bootstrap seeds run as the schema-owner role.`);
  }
  return value;
}

// Schema-owner role: same host/port/database as the app pool, owner credentials. No statement/lock
// timeout here (see the role_session_timeouts migration) — a long migration must run to completion,
// not get killed mid-DDL. connectionTimeoutMillis still applies: a migrate/seed run against an
// unreachable database should fail fast, not hang the CLI indefinitely.
export function createOwnerPool(): Pool {
  return new Pool({
    ...connection,
    user: requireEnv('DB_OWNER_USER'),
    password: requireEnv('DB_OWNER_PASSWORD'),
    connectionTimeoutMillis: 10000,
  });
}

// Lightweight connectivity probe for the health endpoint. Throws if the DB is unreachable.
export async function pingDatabase(probe: Queryable): Promise<void> {
  await probe.query('SELECT 1');
}
