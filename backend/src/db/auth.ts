import { query, queryOne } from './core';
import type { Queryable } from './core';
import { SESSION_DAYS, type UsersWireRow } from '../auth';

// Login row carries the password material (never sent to the client) on top of the wire columns.
export type LoginUserRow = UsersWireRow & { password_hash: string; password_salt: string };

// The wire-safe user projection, retyped across login/password-update/session-load — one column
// list so the three can't drift. userWireColumns() prefixes it for a joined query's table alias.
const USER_WIRE_COLUMN_NAMES = [
  'id', 'username', 'email', 'role', 'business_id', 'is_active', 'must_change_password',
] as const;
const USER_WIRE_COLUMNS = USER_WIRE_COLUMN_NAMES.join(', ');
function userWireColumns(alias: string): string {
  return USER_WIRE_COLUMN_NAMES.map((c) => `${alias}.${c}`).join(', ');
}

export function findUserForLogin(db: Queryable, username: string): Promise<LoginUserRow | null> {
  return queryOne<LoginUserRow>(
    db,
    `SELECT ${USER_WIRE_COLUMNS}, password_hash, password_salt
       FROM auth.users
      WHERE username = $1`,
    [username],
  );
}

export async function createSession(db: Queryable, userId: number, tokenHash: string): Promise<void> {
  await query(
    db,
    `INSERT INTO auth.sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [userId, tokenHash, SESSION_DAYS],
  );
}

export async function deleteSessionByToken(db: Queryable, tokenHash: string): Promise<void> {
  await query(db, `DELETE FROM auth.sessions WHERE token_hash = $1`, [tokenHash]);
}

export function getPasswordCreds(
  db: Queryable,
  userId: number,
): Promise<{ password_hash: string; password_salt: string } | null> {
  return queryOne<{ password_hash: string; password_salt: string }>(
    db,
    `SELECT password_hash, password_salt FROM auth.users WHERE id = $1`,
    [userId],
  );
}

export function updateUserPassword(
  db: Queryable,
  userId: number,
  passwordHash: string,
  passwordSalt: string,
): Promise<UsersWireRow | null> {
  return queryOne<UsersWireRow>(
    db,
    `UPDATE auth.users
        SET password_hash = $1, password_salt = $2, must_change_password = false, updated_at = now()
      WHERE id = $3
      RETURNING ${USER_WIRE_COLUMNS}`,
    [passwordHash, passwordSalt, userId],
  );
}

// Invalidate the user's other sessions (keeps the current token) after a password change.
export async function deleteOtherSessions(db: Queryable, userId: number, keepTokenHash: string): Promise<void> {
  await query(
    db,
    `DELETE FROM auth.sessions WHERE user_id = $1 AND token_hash <> $2`,
    [userId, keepTokenHash],
  );
}

// Validates a session token: unexpired session whose user is still active. Null otherwise.
export function loadSessionUser(db: Queryable, tokenHash: string): Promise<UsersWireRow | null> {
  return queryOne<UsersWireRow>(
    db,
    `SELECT s.id AS session_id, ${userWireColumns('u')}
       FROM auth.sessions s
       JOIN auth.users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.expires_at > now()
        AND u.is_active = true`,
    [tokenHash],
  );
}
