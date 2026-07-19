import { Pool } from 'pg';
import type { Queryable } from './db/core';
import dotenv from 'dotenv';

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
