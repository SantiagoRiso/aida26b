import type { Role } from './types/roles';

// Demo/local-only fixtures shared by the backend seed scripts (seed-demo.ts, seed-foundation.ts)
// and the frontend e2e specs. Never real secrets — these identify dev/demo accounts and dataset
// values only. One source means a renamed demo account or service can't silently break e2e.

export const DEMO_PASSWORD = 'demo-pass-123';

// The demo accounts e2e logs in as. seed-demo.ts seeds users under these exact usernames (plus
// many more clients/professionals that e2e never references by name).
export const DEMO_ACCOUNTS = {
  adminUser:             { username: 'demo_admin',          role: 'Admin' as Role },
  professionalUser:      { username: 'demo_pro',            role: 'Professional' as Role },
  receptionistWithGrant: { username: 'demo_recep',          role: 'Receptionist' as Role },
  client:                { username: 'demo_client',         role: 'Client' as Role },
  clientOverdue:         { username: 'demo_client_overdue', role: 'Client' as Role },
  // The ONLY seeded must_change_password account — consumed by forced-password-change.spec.ts only.
  forcedResetUser:       { username: 'demo_reset',          role: 'Professional' as Role },
} as const;

// Service catalog names from seed-demo.ts's SERVICE_DEFS — stable enough for e2e to assert
// against (e.g. selecting a service by label) without hardcoding the Spanish string per spec.
export const DEMO_SERVICE_NAMES = {
  sesion: 'Sesión de Psicología Infantil',
  nutricion: 'Consulta nutricional',
  kineso: 'Sesión de kinesiología',
  medico: 'Consulta médica',
} as const;
