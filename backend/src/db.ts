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

export const pool = new Pool({
  ...connection,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
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

// Schema-owner role: same host/port/database as the app pool, owner credentials.
export function createOwnerPool(): Pool {
  return new Pool({
    ...connection,
    user: requireEnv('DB_OWNER_USER'),
    password: requireEnv('DB_OWNER_PASSWORD'),
  });
}

// Lightweight connectivity probe for the health endpoint. Throws if the DB is unreachable.
export async function pingDatabase(probe: Queryable): Promise<void> {
  await probe.query('SELECT 1');
}
