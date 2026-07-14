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

// The demo dataset's fixtures were authored against this Monday. Both the backend seed and the e2e
// specs shift every fixture date onto the current week so the data never rots — and because the shift
// is a whole number of weeks (anchor and target are both Mondays), weekday and time-of-day are
// preserved, keeping appointments on each professional's real working days. Single source so seed and
// specs shift by the exact same amount and stay aligned.
export const SEED_ANCHOR = '2026-07-06';

export function currentMondayISO(): string {
  const now = new Date();
  const dow = now.getDay(); // 0=Sun..6=Sat
  const backToMonday = dow === 0 ? 6 : dow - 1;
  const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - backToMonday);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${mon.getFullYear()}-${pad(mon.getMonth() + 1)}-${pad(mon.getDate())}`;
}

function daysBetween(fromISO: string, toISO: string): number {
  const [fy, fm, fd] = fromISO.split('-').map(Number);
  const [ty, tm, td] = toISO.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

// Shift a fixture date (either 'YYYY-MM-DD' or a full ISO 'YYYY-MM-DDTHH:MM:SS±hh:mm') by the whole
// number of weeks separating SEED_ANCHOR from the current week's Monday.
export function shiftSeedDate(iso: string): string {
  const shiftDays = daysBetween(SEED_ANCHOR, currentMondayISO());
  const hasTime = iso.includes('T');
  const datePart = hasTime ? iso.slice(0, 10) : iso;
  const rest = hasTime ? iso.slice(10) : '';
  const [y, m, d] = datePart.split('-').map(Number);
  const dt = new Date(y, m - 1, d + shiftDays);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}${rest}`;
}

// Monday of the current week — the demo seed's dense-fill start.
export const SEED_START = shiftSeedDate(SEED_ANCHOR);
