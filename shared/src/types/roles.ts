// Single runtime source for the user-role set. The Role type and the isRole guard both derive
// from ROLES, so adding or renaming a role is one edit here. The SQL CHECK on auth.users mirrors
// this set in an immutable migration — keep them in sync (a drift assertion guards this).
export const ROLES = ['Admin', 'Professional', 'Receptionist', 'Client'] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return ROLES.some((role) => role === value);
}
