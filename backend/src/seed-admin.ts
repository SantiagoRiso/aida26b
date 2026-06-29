import { Pool } from 'pg';
import dotenv from 'dotenv';
import { hashPassword } from './auth';

dotenv.config();

async function main() {
  const username = process.env.ADMIN_USERNAME?.trim();
  const password = process.env.ADMIN_PASSWORD;
  const email = process.env.ADMIN_EMAIL?.trim() || null;

  if (!username || !password || password.length < 8) {
    throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD with at least 8 characters are required');
  }

  const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  const { passwordHash, passwordSalt } = await hashPassword(password);

  // Schema is business-scoped: ensure a business exists and link the admin to it.
  const business = await pool.query<{ id: number }>(
    `WITH existing AS (SELECT id FROM businesses ORDER BY id LIMIT 1),
          created AS (
            INSERT INTO businesses (name)
            SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM existing)
            RETURNING id
          )
     SELECT id FROM existing UNION ALL SELECT id FROM created`,
    [process.env.BUSINESS_NAME?.trim() || 'Default Business'],
  );
  const businessId = business.rows[0].id;

  await pool.query(
    `INSERT INTO auth.users (username, email, password_hash, password_salt, role, business_id, is_active, must_change_password)
     VALUES ($1, $2, $3, $4, 'Admin', $5, true, false)
     ON CONFLICT (username) DO UPDATE
       SET email = EXCLUDED.email,
           password_hash = EXCLUDED.password_hash,
           password_salt = EXCLUDED.password_salt,
           role = 'Admin',
           business_id = EXCLUDED.business_id,
           is_active = true,
           must_change_password = false,
           updated_at = now()`,
    [username, email, passwordHash, passwordSalt, businessId],
  );

  await pool.end();
  console.log(`Admin user ready: ${username}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
