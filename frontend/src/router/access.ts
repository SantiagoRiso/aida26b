import type { Role } from '@shared/types/roles';
import type { TableKey } from '@shared/ssot/derived';
import { tableOf } from '@shared/utils/utils';

// The single place role-access logic lives.
// No view or component checks user.role directly — import from here instead.

export function roleAllowedFor(roles: Role[] | undefined, role: Role): boolean {
  if (!roles || roles.length === 0) return true;
  return roles.includes(role);
}

// Roles a table's descriptor grants for a write op, optionally minus roles a screen deliberately
// handles elsewhere (e.g. a Client edits their profile in the portal, not the staff panel). The
// list is derived from roleRequired, so tightening the descriptor server-side hides the control
// here too — no parallel role list to keep in sync.
export function descriptorWriteRoles(
  table: TableKey,
  op: 'create' | 'update' | 'delete',
  opts?: { exclude?: Role[] },
): Role[] {
  const allowed = tableOf(table).roleRequired?.[op] ?? [];
  const excluded = opts?.exclude;
  return excluded ? allowed.filter((role) => !excluded.includes(role)) : allowed;
}

// Ownership and calendar-grant checks are server-enforced; this only covers
// the SSOT roleRequired.read mapping used for route meta.
export function canAccessRoute(user: { role: Role } | null, meta: { roles?: Role[] }): boolean {
  if (!user) return false;
  return roleAllowedFor(meta.roles, user.role);
}

// Screen → access source. Table-backed screens derive their roles from the SSOT
// descriptor's roleRequired.read; an `override` narrows that list (never widens —
// guarded by test/screen-roles.test.ts); `roles` entries are UI judgment calls with
// no single backing table. Route meta is a first cut only; the server independently
// enforces access (e.g. Users via /api/admin/users).
type ScreenAccess = { table: TableKey; override?: Role[] } | { roles: Role[] };

export const SCREEN_ACCESS: Record<string, ScreenAccess> = {
  'staff-dashboard': { roles: ['Admin', 'Professional', 'Receptionist'] },
  'staff-calendar': { roles: ['Admin', 'Professional', 'Receptionist'] },
  'staff-schedule': { table: 'schedule_blocks' },
  'staff-requests': { roles: ['Admin', 'Professional', 'Receptionist'] },
  // The descriptor's Client read exists for the portal API; the staff shell stays staff-only.
  'staff-clients': { table: 'clients', override: ['Admin', 'Professional', 'Receptionist'] },
  // A Professional manages themself through Perfil, not the professionals roster.
  'staff-professionals': { table: 'professionals', override: ['Admin', 'Receptionist'] },
  'staff-profile': { roles: ['Professional'] },
  // Business config (catalog, bindings, booking policy) is admin-owned; receptionists and
  // professionals consume services/resources through the booking form, not these screens.
  'staff-business': { roles: ['Admin'] },
  'staff-users': { table: 'users' },
  // audit_events declares no roleRequired (its Admin-only read is a bespoke route,
  // not generic CRUD), so there is nothing to derive from.
  'staff-audit': { roles: ['Admin'] },
  'staff-settings': { roles: ['Admin', 'Professional', 'Receptionist'] },
  'portal-appointments': { roles: ['Client'] },
  'portal-balance': { roles: ['Client'] },
  'portal-preferences': { roles: ['Client'] },
};

function resolveScreenRoles(entry: ScreenAccess): Role[] {
  if ('roles' in entry) return entry.roles;
  const read = tableOf(entry.table).roleRequired?.read;
  if (!read) throw new Error(`SCREEN_ACCESS: table '${entry.table}' has no roleRequired.read to derive from`);
  return entry.override ?? read;
}

export const SCREEN_ROLES: Record<string, Role[]> = Object.fromEntries(
  Object.entries(SCREEN_ACCESS).map(([screen, entry]) => [screen, resolveScreenRoles(entry)]),
);
