import dotenv from 'dotenv';
import { createOwnerPool } from './db';
import { hashPassword, MIN_PASSWORD_LENGTH } from './auth';

dotenv.config();

async function main() {
  const username = process.env.ADMIN_USERNAME?.trim();
  const password = process.env.ADMIN_PASSWORD;
  const email = process.env.ADMIN_EMAIL?.trim() || null;

  if (!username || !password || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_USERNAME and ADMIN_PASSWORD with at least ${MIN_PASSWORD_LENGTH} characters are required`);
  }

  // Only Clients may go without an email; a null one here reaches the database as a constraint
  // violation, so name the missing variable instead.
  if (!email) {
    throw new Error('ADMIN_EMAIL is required: only clients may be recorded without an email');
  }

  // Owner role: the app role can't write config tables like businesses.
  const pool = createOwnerPool();

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
  const businessId = business.rows[0]?.id;

  // An Admin must always have a business; fail fast if none could be resolved.
  if (businessId == null) {
    throw new Error('Could not resolve or create a business for the admin user');
  }

  await pool.query(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, is_active, must_change_password)
     VALUES ($1, $2, $3, $4, $5, 'Admin', $6, true, false)
     ON CONFLICT (username) DO UPDATE
       SET email = EXCLUDED.email,
           display_name = EXCLUDED.display_name,
           password_hash = EXCLUDED.password_hash,
           password_salt = EXCLUDED.password_salt,
           role = 'Admin',
           business_id = EXCLUDED.business_id,
           is_active = true,
           must_change_password = false,
           updated_at = now()`,
    [username, email, username, passwordHash, passwordSalt, businessId],
  );

  await pool.end();
  console.log(`Admin user ready: ${username}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
