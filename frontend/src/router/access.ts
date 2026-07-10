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
  'staff-requests': ['Admin', 'Professional', 'Receptionist'],
  'staff-clients': ['Admin', 'Professional', 'Receptionist'],
  'staff-professionals': ['Admin', 'Professional', 'Receptionist'],
  // Catalog management is not front-desk work; receptionists consume services/resources
  // through the booking form, not these screens.
  'staff-services': ['Admin', 'Professional'],
  'staff-resources': ['Admin', 'Professional'],
  'staff-users': ['Admin'],
  'staff-audit': ['Admin'],
  'staff-settings': ['Admin', 'Professional', 'Receptionist'],
  'portal-appointments': ['Client'],
  'portal-balance': ['Client'],
  'portal-preferences': ['Client'],
};
