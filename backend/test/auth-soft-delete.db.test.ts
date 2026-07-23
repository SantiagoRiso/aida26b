import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { findUserForLogin, createSession, loadSessionUser } from '../src/db/auth';
import { newSessionToken, hashToken } from '../src/auth';

// A soft-deleted user must not be able to log in, and any session they already hold must stop
// validating. deleted_at alone is the source of truth here — is_active is deliberately left set,
// so authentication cannot come to depend on it. Each test seeds its own user so the soft-delete
// performed by one test can't leak state into another.
describe('soft-deleted users cannot authenticate', () => {
  let pool: Pool;
  let bizId: string;

  beforeAll(async () => {
    await resetTestDb();
    pool = makeTestPool();
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    const biz = await pool.query<{ id: string }>(
      `INSERT INTO businesses (name) VALUES ('Soft Delete Biz') RETURNING id`,
    );
    bizId = biz.rows[0].id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedUser(username: string): Promise<number> {
    const user = await pool.query<{ id: string }>(
      `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id)
       VALUES ($1, $2, 'Test User', 'h', 's', 'Client', $3) RETURNING id`,
      [username, `${username}@test.local`, bizId],
    );
    return Number(user.rows[0].id);
  }

  // Stamps deleted_at only, leaving is_active true: authentication must key on the archive stamp
  // by itself, so it stays closed no matter what else an archival path happens to set.
  async function softDelete(userId: number): Promise<void> {
    await pool.query(
      `UPDATE auth.users SET deleted_at = now(), updated_at = now() WHERE id = $1`,
      [userId],
    );
  }

  test('findUserForLogin returns the row while the user is active', async () => {
    const username = 'active_login_user';
    const userId = await seedUser(username);

    const row = await findUserForLogin(pool, username);
    expect(row).not.toBeNull();
    expect(Number(row!.id)).toBe(userId);
  });

  test('findUserForLogin returns null after soft-delete, same shape as an unknown username', async () => {
    const username = 'deleted_login_user';
    const userId = await seedUser(username);
    await softDelete(userId);

    const row = await findUserForLogin(pool, username);
    expect(row).toBeNull();

    const unknownRow = await findUserForLogin(pool, 'no_such_user_at_all');
    expect(unknownRow).toBeNull();
  });

  test('loadSessionUser validates a session while the user is active', async () => {
    const username = 'active_session_user';
    const userId = await seedUser(username);
    const token = newSessionToken();
    await createSession(pool, userId, hashToken(token));

    const row = await loadSessionUser(pool, hashToken(token));
    expect(row).not.toBeNull();
    expect(Number(row!.id)).toBe(userId);
  });

  test('an existing session stops validating once the user is soft-deleted', async () => {
    const username = 'session_then_deleted_user';
    const userId = await seedUser(username);
    const token = newSessionToken();
    await createSession(pool, userId, hashToken(token));

    // Confirm the session is genuinely live before the delete, to prove the later null is
    // caused by the delete and not by some other setup mistake.
    const before = await loadSessionUser(pool, hashToken(token));
    expect(before).not.toBeNull();

    await softDelete(userId);

    const after = await loadSessionUser(pool, hashToken(token));
    expect(after).toBeNull();
  });
});
