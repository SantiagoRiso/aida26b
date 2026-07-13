import { query, queryOne } from './core';
import type { Queryable } from './core';
import type { ActiveProfessionalRow, ActiveUserRow, SelfProfileRow } from '../../../shared/src/ssot/query-types';
import type { SqlParam } from '../../../shared/src/types/types';

export function findActiveProfessional(db: Queryable, userId: number | string): Promise<ActiveProfessionalRow | null> {
  return queryOne<ActiveProfessionalRow>(
    db,
    `SELECT id AS user_id, business_id
       FROM auth.users
      WHERE id = $1 AND role = 'Professional' AND is_active = true`,
    [userId],
  );
}

// Any active user, with role — used to validate a grant's grantee.
export function findActiveUser(db: Queryable, userId: number | string): Promise<ActiveUserRow | null> {
  return queryOne<ActiveUserRow>(
    db,
    `SELECT id, role, business_id FROM auth.users WHERE id = $1 AND is_active = true`,
    [userId],
  );
}

// True when an active Client with this id exists in the business — the ledger's tenant guard.
export async function activeClientInBusiness(db: Queryable, clientUserId: number, businessId: number): Promise<boolean> {
  const rows = await query(
    db,
    `SELECT id FROM auth.users WHERE id = $1 AND role = 'Client' AND business_id = $2 AND is_active = true`,
    [clientUserId, businessId],
  );
  return rows.length > 0;
}

// The business a user belongs to (used by the audit writer to scope events). Null when unresolved.
export function getUserBusinessId(db: Queryable, userId: number): Promise<number | null> {
  return queryOne<{ business_id: number | null }>(
    db,
    `SELECT business_id FROM auth.users WHERE id = $1`,
    [userId],
  ).then((r) => r?.business_id ?? null);
}

// The self-service profile read: secret-free view, scoped to the caller's own active row.
export function getSelfProfile(db: Queryable, userId: number): Promise<SelfProfileRow | null> {
  return queryOne<SelfProfileRow>(
    db,
    `SELECT id, display_name, bio, email, phone
       FROM auth.users_directory
      WHERE id = $1 AND is_active = true`,
    [userId],
  );
}

// Self-service profile write: only the caller's own row, only these four fields.
export function updateSelfProfile(
  db: Queryable,
  opts: { userId: number; displayName: string; bio: string | null; email: string; phone: string | null },
): Promise<SelfProfileRow | null> {
  return queryOne<SelfProfileRow>(
    db,
    `UPDATE auth.users
        SET display_name = $2, bio = $3, email = $4, phone = $5, updated_at = now()
      WHERE id = $1 AND is_active = true
      RETURNING id, display_name, bio, email, phone`,
    [opts.userId, opts.displayName, opts.bio, opts.email, opts.phone],
  );
}

export function insertUser(
  db: Queryable,
  u: {
    username: string;
    email: string;
    displayName: string;
    dni: string | null;
    passwordHash: string;
    passwordSalt: string;
    role: string;
    businessId: number;
  },
): Promise<{ id: string } | null> {
  return queryOne<{ id: string }>(
    db,
    `INSERT INTO auth.users
       (username, email, display_name, dni, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
     RETURNING id`,
    [u.username, u.email, u.displayName, u.dni, u.passwordHash, u.passwordSalt, u.role, u.businessId],
  );
}

// Contact-only client: no login credentials (username/password stay NULL). Bookable, cannot log in.
export function insertContactOnlyClient(
  db: Queryable,
  u: { email: string; displayName: string; dni: string | null; businessId: number },
): Promise<{ id: string } | null> {
  return queryOne<{ id: string }>(
    db,
    `INSERT INTO auth.users (email, display_name, dni, role, business_id)
     VALUES ($1, $2, $3, 'Client', $4)
     RETURNING id`,
    [u.email, u.displayName, u.dni, u.businessId],
  );
}

// Activate login on a contact-only client (username IS NULL guards against overwriting an
// existing login). Forces a password change on first login. Duplicate username -> DbError 23505.
export function enableClientLogin(
  db: Queryable,
  opts: { userId: number; businessId: number; username: string; passwordHash: string; passwordSalt: string },
): Promise<{ id: string; username: string } | null> {
  return queryOne<{ id: string; username: string }>(
    db,
    `UPDATE auth.users
        SET username = $1, password_hash = $2, password_salt = $3, must_change_password = true, updated_at = now()
      WHERE id = $4 AND business_id = $5 AND role = 'Client' AND is_active = true AND username IS NULL
      RETURNING id, username`,
    [opts.username, opts.passwordHash, opts.passwordSalt, opts.userId, opts.businessId],
  );
}

// Deactivate (never delete) a user in the caller's business, stamping who did it. Null when no
// matching active user exists in that business.
export function deactivateUser(
  db: Queryable,
  opts: { userId: number; businessId: number; actorId: number },
): Promise<{ id: string; username: string; role: string } | null> {
  return queryOne<{ id: string; username: string; role: string }>(
    db,
    `UPDATE auth.users
        SET is_active = false, deleted_at = now(), deleted_by_user_id = $1, updated_at = now()
      WHERE id = $2 AND business_id = $3 AND is_active = true
      RETURNING id, username, role`,
    [opts.actorId, opts.userId, opts.businessId],
  );
}

export function resetUserPassword(
  db: Queryable,
  opts: { userId: number; businessId: number; passwordHash: string; passwordSalt: string },
): Promise<{ id: string; username: string; email: string | null; role: string; is_active: boolean; must_change_password: boolean } | null> {
  return queryOne<{ id: string; username: string; email: string | null; role: string; is_active: boolean; must_change_password: boolean }>(
    db,
    `UPDATE auth.users
        SET password_hash = $1, password_salt = $2, must_change_password = true, updated_at = now()
      WHERE id = $3 AND business_id = $4 AND is_active = true
      RETURNING id, username, email, role, is_active, must_change_password`,
    [opts.passwordHash, opts.passwordSalt, opts.userId, opts.businessId],
  );
}

export async function deleteUserSessions(db: Queryable, userId: number): Promise<void> {
  await query(db, `DELETE FROM auth.sessions WHERE user_id = $1`, [userId]);
}

// A user of a given role (not soft-deleted) and its business, for FK role-integrity checks.
// Null when no such user exists.
export function findRoleUserBusiness(
  db: Queryable,
  userId: SqlParam,
  role: string,
): Promise<{ business_id: string | null } | null> {
  return queryOne<{ business_id: string | null }>(
    db,
    `SELECT business_id FROM auth.users WHERE id = $1 AND role = $2 AND deleted_at IS NULL`,
    [userId, role],
  );
}
