import type { Role } from '@shared/types/types';

// The single place role-access logic lives.
// No view or component checks user.role directly — import from here instead.

// An undefined/empty roles array means any authenticated user may access the route.
export function roleAllowedFor(roles: Role[] | undefined, role: Role): boolean {
  if (!roles || roles.length === 0) return true;
  return roles.includes(role);
}

// Ownership and calendar-grant checks are server-enforced; this only covers
// the SSOT roleRequired.read mapping used for route meta.
export function canAccessRoute(user: { role: Role } | null, meta: { roles?: Role[] }): boolean {
  if (!user) return false;
  return roleAllowedFor(meta.roles, user.role);
}

// Screen → required-roles mapping derived from SSOT roleRequired.read.
// Route meta is a first cut only; the server independently enforces access
// (e.g. Users via /api/admin/users).
export const SCREEN_ROLES: Record<string, Role[]> = {
  'staff-dashboard': ['Admin', 'Professional', 'Receptionist'],
  'staff-calendar': ['Admin', 'Professional', 'Receptionist'],
  'staff-clients': ['Admin', 'Professional', 'Receptionist'],
  'staff-professionals': ['Admin', 'Professional', 'Receptionist'],
  'staff-services': ['Admin', 'Professional', 'Receptionist'],
  'staff-resources': ['Admin', 'Professional', 'Receptionist'],
  'staff-users': ['Admin'],
  'staff-ledger': ['Admin', 'Receptionist', 'Professional'],
  'staff-audit': ['Admin'],
  'staff-settings': ['Admin', 'Professional', 'Receptionist'],
  'portal-appointments': ['Client'],
  'portal-request': ['Client'],
  'portal-balance': ['Client'],
  'portal-preferences': ['Client'],
};
