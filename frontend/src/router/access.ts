import type { Role } from '@shared/types/types';

// The single place role-access logic lives.
// No view or component checks user.role directly — import from here instead.

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
  'staff-schedule': ['Admin', 'Professional', 'Receptionist'],
  'staff-requests': ['Admin', 'Professional', 'Receptionist'],
  'staff-clients': ['Admin', 'Professional', 'Receptionist'],
  // A Professional manages themself through Perfil, not the professionals roster.
  'staff-professionals': ['Admin', 'Receptionist'],
  'staff-profile': ['Professional'],
  // Business config (catalog, bindings, booking policy) is admin-owned; receptionists and
  // professionals consume services/resources through the booking form, not these screens.
  'staff-business': ['Admin'],
  'staff-users': ['Admin'],
  'staff-audit': ['Admin'],
  'staff-settings': ['Admin', 'Professional', 'Receptionist'],
  'portal-appointments': ['Client'],
  'portal-balance': ['Client'],
  'portal-preferences': ['Client'],
};
