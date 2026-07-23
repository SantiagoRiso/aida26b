import { query, queryOne, queryRequired } from './core';
import type { Queryable, SqlParam } from './core';
import { softDeleteAssignments } from './generic';
import { getSoftDeletePolicy } from '../../../shared/src/utils/utils';
import type { Role } from '../../../shared/src/types/roles';
import type { UserProbeRow, SelfProfileRow } from '../../../shared/src/ssot/query-types';

// A tenant Admin may only touch users of their own business; a super-admin (Admin with no business)
// administers users in any tenant. Spelled as a union rather than a nullable business id so the
// unscoped reach has to be asked for and cannot be reached by a null slipping through.
export type UserAdminScope =
  | { kind: 'tenant'; businessId: number }
  | { kind: 'all' };

// Appends the scope predicate to `params` and returns it. 'all' contributes no predicate at all,
// so a business-less target (another super-admin) is still reachable.
function scopePredicate(scope: UserAdminScope, params: SqlParam[]): string {
  if (scope.kind === 'all') return 'true';
  params.push(scope.businessId);
  return `business_id = $${params.length}`;
}

// The one "does this user exist" probe: optionally narrowed by role, tenant, and activity.
// Booking/ledger tenant guards pass activeOnly (a deactivated client books like an unknown one);
// history/read guards omit it — deactivation never hides what already happened. Returns the row
// (grants need business_id/role); existence-only callers just null-check.
export function findUser(
  db: Queryable,
  opts: { id: number | string; businessId?: number; role?: Role; activeOnly?: boolean },
): Promise<UserProbeRow | null> {
  const conditions = ['id = $1'];
  const params: SqlParam[] = [opts.id];
  if (opts.role !== undefined) {
    params.push(opts.role);
    conditions.push(`role = $${params.length}`);
  }
  if (opts.businessId !== undefined) {
    params.push(opts.businessId);
    conditions.push(`business_id = $${params.length}`);
  }
  if (opts.activeOnly) conditions.push('is_active = true');
  return queryOne<UserProbeRow>(
    db,
    `SELECT id, role, business_id FROM auth.users WHERE ${conditions.join(' AND ')}`,
    params,
  );
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
  opts: { userId: number; displayName: string; bio: string | null; email: string | null; phone: string | null },
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
    email: string | null;
    displayName: string;
    dni: string | null;
    passwordHash: string;
    passwordSalt: string;
    role: string;
    businessId: number;
  },
): Promise<{ id: string }> {
  return queryRequired<{ id: string }>(
    db,
    `INSERT INTO auth.users
       (username, email, display_name, dni, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
     RETURNING id`,
    [u.username, u.email, u.displayName, u.dni, u.passwordHash, u.passwordSalt, u.role, u.businessId],
  );
}

// Contact-only client: no login credentials (username/password stay NULL) and no email required.
// Bookable, cannot log in.
export function insertContactOnlyClient(
  db: Queryable,
  u: { email: string | null; displayName: string; dni: string | null; businessId: number },
): Promise<{ id: string }> {
  return queryRequired<{ id: string }>(
    db,
    `INSERT INTO auth.users (email, display_name, dni, role, business_id)
     VALUES ($1, $2, $3, 'Client', $4)
     RETURNING id`,
    [u.email, u.displayName, u.dni, u.businessId],
  );
}

// A contact-only client (no login yet) the caller may reach, with the email the account currently
// carries and the tenant it belongs to. Null when no such client exists.
export function findContactOnlyClient(
  db: Queryable,
  opts: { userId: number; scope: UserAdminScope },
): Promise<{ email: string | null; business_id: string | null } | null> {
  const params: SqlParam[] = [opts.userId];
  const scoped = scopePredicate(opts.scope, params);
  return queryOne<{ email: string | null; business_id: string | null }>(
    db,
    `SELECT email, business_id FROM auth.users
      WHERE id = $1 AND ${scoped} AND role = 'Client' AND is_active = true AND username IS NULL`,
    params,
  );
}

// Activate login on a contact-only client (username IS NULL guards against overwriting an
// existing login). Forces a password change on first login. Duplicate username -> DbError 23505.
// An account that already has an email keeps it: this is not an identity-change endpoint.
export function enableClientLogin(
  db: Queryable,
  opts: { userId: number; scope: UserAdminScope; username: string; email: string | null; passwordHash: string; passwordSalt: string },
): Promise<{ id: string; username: string; business_id: string | null } | null> {
  const params: SqlParam[] = [
    opts.username, opts.passwordHash, opts.passwordSalt, opts.userId, opts.email,
  ];
  const scoped = scopePredicate(opts.scope, params);
  return queryOne<{ id: string; username: string; business_id: string | null }>(
    db,
    `UPDATE auth.users
        SET username = $1, password_hash = $2, password_salt = $3, must_change_password = true,
            email = COALESCE(email, $5), updated_at = now()
      WHERE id = $4 AND ${scoped} AND role = 'Client' AND is_active = true AND username IS NULL
        AND COALESCE(email, $5) IS NOT NULL
      RETURNING id, username, business_id`,
    params,
  );
}

// Archive (never delete) a user the caller may reach, stamping who did it. Null when no matching
// live user exists within scope. Column effects and the "already archived" guard come from the same
// SSoT policy the generic DELETE compiles, so the two archival paths stay one rule.
export function deactivateUser(
  db: Queryable,
  opts: { userId: number; scope: UserAdminScope; actorId: number },
): Promise<{ id: string; username: string; role: string; business_id: string | null } | null> {
  const policy = getSoftDeletePolicy('users');
  if (!policy) throw new Error('users descriptor lost its soft-delete policy');

  const params: SqlParam[] = [opts.actorId, opts.userId];
  const scoped = scopePredicate(opts.scope, params);

  return queryOne<{ id: string; username: string; role: string; business_id: string | null }>(
    db,
    `UPDATE auth.users
        SET ${softDeleteAssignments(policy, 1).join(', ')}
      WHERE id = $2 AND ${scoped} AND ${policy.deletedAtColumn} IS NULL
      RETURNING id, username, role, business_id`,
    params,
  );
}

export function resetUserPassword(
  db: Queryable,
  opts: { userId: number; scope: UserAdminScope; passwordHash: string; passwordSalt: string },
): Promise<{ id: string; username: string; email: string | null; role: string; is_active: boolean; must_change_password: boolean; business_id: string | null } | null> {
  const params: SqlParam[] = [opts.passwordHash, opts.passwordSalt, opts.userId];
  const scoped = scopePredicate(opts.scope, params);
  return queryOne<{ id: string; username: string; email: string | null; role: string; is_active: boolean; must_change_password: boolean; business_id: string | null }>(
    db,
    `UPDATE auth.users
        SET password_hash = $1, password_salt = $2, must_change_password = true, updated_at = now()
      WHERE id = $3 AND ${scoped} AND is_active = true
      RETURNING id, username, email, role, is_active, must_change_password, business_id`,
    params,
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
