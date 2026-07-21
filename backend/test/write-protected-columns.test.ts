import { describe, it, expect } from 'vitest';
import { getWriteProtectedColumns, getTableKeys, tableOf } from '../../shared/src/utils/utils';

// The denylist guards privileged auth state against a future descriptor edit, so it is pinned here:
// dropping an entry has to fail a test rather than silently open a generic write path.
describe('write-protected columns', () => {
  it('pins the auth.users denylist', () => {
    expect([...getWriteProtectedColumns('auth.users')].sort()).toEqual([
      'business_id',
      'deleted_at',
      'deleted_by_user_id',
      'is_active',
      'must_change_password',
      'password_hash',
      'password_salt',
      'role',
    ]);
  });

  it('protects nothing on a table that declares no denylist', () => {
    expect(getWriteProtectedColumns('services').size).toBe(0);
  });

  // Keying on the physical write table is what makes the protection independent of any single
  // descriptor: every logical view over auth.users resolves to the same denylist, including one
  // added later.
  it('covers every descriptor whose writes land on auth.users', () => {
    const authUsersViews = getTableKeys().filter((key) => tableOf(key).sqlTable === 'auth.users');
    expect(authUsersViews).toContain('clients');
    expect(authUsersViews).toContain('professionals');
    for (const key of authUsersViews) {
      expect(getWriteProtectedColumns(tableOf(key).sqlTable ?? key).has('role')).toBe(true);
    }
  });
});
