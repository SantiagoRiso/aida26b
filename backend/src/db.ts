import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// Lightweight connectivity probe for the health endpoint. Throws if the DB is unreachable.
export async function pingDatabase(probe: Pick<Pool, 'query'>): Promise<void> {
  await probe.query('SELECT 1');
}
