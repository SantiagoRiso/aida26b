import { expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import { DEMO_ACCOUNTS as DEMO_USERS, DEMO_PASSWORD } from '../../shared/src/dev-fixtures';
import { APPOINTMENT_STATES } from '../../shared/src/ssot/domain/appointment-lifecycle';
// The UI-string SSoT. `es` is pure data (no runtime imports), so it loads in the Playwright loader
// just as it does in Vitest — specs reference `es.*` instead of hand-copying literals (which drift:
// e.g. actions.cancel 'Cancelar' vs calendar.cancel 'Cancelar turno'). This is the single import
// point; specs do `import { es } from './helpers'`.
import { es } from '../src/i18n/es';
export { es };

// State labels come straight from the SSoT (value → localized label), never a copied map.
const STATE_LABELS_ES: Record<string, string> = Object.fromEntries(
  APPOINTMENT_STATES.map((s) => [s.value, s.label.es]),
);
export function stateLabelEs(value: string): string {
  const label = STATE_LABELS_ES[value];
  if (!label) throw new Error(`Unknown appointment state '${value}'`);
  return label;
}

export const toastEs = es.toast;

// A fixture date N days from *today*, as 'YYYY-MM-DD' in local time. Fixtures use this instead of
// hardcoded calendar dates so they never rot: the built server evaluates the booking window and
// availability against its real clock, so a fixed date eventually drifts into the past or outside
// the window. Offsets past ~37 clear the demo seed's dense-fill window; requests stay within the
// booking window (see each spec).
export function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Demo/local-only credentials, shared with the demo seed script (backend/src/seed-demo.ts) via
// shared/src/dev-fixtures.ts so a renamed demo account can't silently break e2e logins.
// These are never real secrets — they identify dev/demo accounts only.

export const DEMO_ACCOUNTS = {
  adminUser:             { ...DEMO_USERS.adminUser, password: DEMO_PASSWORD },
  professionalUser:      { ...DEMO_USERS.professionalUser, password: DEMO_PASSWORD },
  receptionistWithGrant: { ...DEMO_USERS.receptionistWithGrant, password: DEMO_PASSWORD },
  client:                { ...DEMO_USERS.client, password: DEMO_PASSWORD },
  clientOverdue:         { ...DEMO_USERS.clientOverdue, password: DEMO_PASSWORD },
  // The ONLY seeded must_change_password account — consumed by forced-password-change.spec.ts only.
  forcedResetUser:       { ...DEMO_USERS.forcedResetUser, password: DEMO_PASSWORD },
} as const;

// Logs in via the real login screen, not the API directly.
export async function login(page: Page, username: string, password: string): Promise<void> {
  // Two attempts: the vite dev server occasionally reloads/re-optimizes on a fresh context's first
  // hit, which can drop the in-flight submit. A clean re-navigation recovers deterministically.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto('/');
      const submit = page.getByRole('button', { name: 'Ingresar' });
      await submit.waitFor({ state: 'visible', timeout: 30_000 }); // SPA mounted
      await page.getByLabel('Usuario').fill(username);
      // #password (not getByLabel) — the show/hide toggle's aria-label also contains "Contraseña".
      await page.locator('#password').fill(password);
      const authResponse = page
        .waitForResponse((r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST', { timeout: 20_000 })
        .catch(() => null);
      await submit.click();
      await authResponse;
      await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15_000 });
      return;
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
}

export async function loginAs(
  page: Page,
  account: keyof typeof DEMO_ACCOUNTS,
): Promise<void> {
  const { username, password } = DEMO_ACCOUNTS[account];
  await login(page, username, password);
}

export async function openScreen(page: Page, label: string): Promise<void> {
  await page.getByRole('link', { name: label, exact: true }).click();
  await page.waitForLoadState('networkidle');
}

// FullCalendar events carry a stable data-testid (see useFullCalendar.ts eventDidMount).
// Clicks "next" week bounded number of times until the target appointment renders —
// the seeded/fixture week's distance from "today" varies with whenever the suite runs.
export async function navigateCalendarToAppointment(
  page: Page,
  appointmentId: number,
  maxClicks = 12,
  direction: 'next' | 'prev' = 'next',
): Promise<void> {
  const target = page.locator(`[data-testid="appt-${appointmentId}"]`);
  for (let i = 0; i < maxClicks; i++) {
    if (await target.first().isVisible().catch(() => false)) return;
    const nextFetch = page.waitForResponse(
      (r) => r.url().includes('/appointments') && r.request().method() === 'GET',
      { timeout: 10_000 },
    ).catch(() => null);
    await page.locator(`.fc-${direction}-button`).click();
    await nextFetch;
  }
  await expect(target.first()).toBeVisible({ timeout: 10_000 });
}

// --- Shared helpers for lifecycle / money-path specs ---
// The staff API is the fixture factory: specs self-seed the exact appointment they need
// (in the exact state, on an untouched professional/client) rather than hunting for a seeded
// row, so they stay race-free under the serial (workers:1) shared-dataset run.

// First matching row id for a GET list endpoint. `page` must be authenticated.
export async function findId(page: Page, path: string): Promise<number> {
  const res = await page.request.get(path);
  const body = await res.json();
  const row = body.data?.[0];
  if (!row?.id) {
    throw new Error(`No row found for ${path}: ${res.status()} ${JSON.stringify(body)}`);
  }
  return Number(row.id);
}

export function findProfessionalId(page: Page, displayName: string): Promise<number> {
  return findId(page, `/api/professionals?filter_display_name=${encodeURIComponent(displayName)}`);
}
export function findClientId(page: Page, displayName: string): Promise<number> {
  return findId(page, `/api/clients?filter_display_name=${encodeURIComponent(displayName)}`);
}
export function findServiceId(page: Page, name: string): Promise<number> {
  return findId(page, `/api/services?filter_name=${encodeURIComponent(name)}`);
}

export interface ScheduleFixture {
  professional_user_id: number;
  service_id: number;
  client_user_id: number;
  date: string;
  start: string;
  duration_minutes: number;
  name?: string;
  override?: boolean;
}

// Creates a scheduled appointment via the staff schedule API (admin/staff-authed page).
// override defaults true so a fixture placed on a densely-seeded slot still saves (a sobreturno)
// instead of returning a conflict verdict — the caller wants the row, not the availability check.
export async function scheduleViaApi(page: Page, fx: ScheduleFixture): Promise<number> {
  const res = await page.request.post('/api/appointments/schedule', {
    data: { override: true, ...fx },
  });
  const body = await res.json();
  if (!res.ok() || !body.data?.id) {
    throw new Error(`schedule fixture failed: ${res.status()} ${JSON.stringify(body)}`);
  }
  return Number(body.data.id);
}

export interface RequestFixture {
  professional_user_id: number;
  service_id: number;
  date: string;
  start: string;
  duration_minutes: number;
  name?: string;
}

// Client-authed page creates a 'requested' appointment (the only way to reach that state).
export async function requestViaApi(page: Page, fx: RequestFixture): Promise<number> {
  const res = await page.request.post('/api/appointments/request', { data: fx });
  const body = await res.json();
  if (!res.ok() || !body.data?.id) {
    throw new Error(`request fixture failed: ${res.status()} ${JSON.stringify(body)}`);
  }
  return Number(body.data.id);
}

export async function getBalance(page: Page, clientUserId: number): Promise<number> {
  const res = await page.request.get(`/api/clients/${clientUserId}/balance`);
  return Number((await res.json()).data.balance_ars);
}

export async function getAppointment(page: Page, id: number): Promise<{ state: string; price: string }> {
  const res = await page.request.get(`/api/appointments/${id}`);
  const { data } = await res.json();
  return { state: data.state, price: data.price };
}

// Selects a value in a searchable Selector (the headlessui Combobox variant: an `input#id` plus
// `[role=option]` list items). Client/professional pickers use this now instead of a native <select>.
// A Selector collapses to a read-only label when it has a single option or is locked, in which case
// there's nothing to pick — callers should not use this helper for those.
export async function selectFromCombobox(page: Page, id: string, text: string): Promise<void> {
  const input = page.locator(`input#${id}`);
  await input.click();
  await input.fill(text);
  await page.getByRole('option').filter({ hasText: text }).first().click();
}

// Fills a DateField (a VueDatePicker). Its typeable input carries no id — the stable hook is the
// `dd/mm/aaaa` placeholder — and it accepts `dd/MM/yyyy` with enter-to-submit. Takes an ISO
// `yyyy-MM-dd` string (the app's value contract). Pass a scope (e.g. a dialog locator) when more
// than one date field is on screen.
export async function fillDate(scope: Page | Locator, isoDate: string): Promise<void> {
  const [y, m, d] = isoDate.split('-');
  const input = scope.locator('input[placeholder="dd/mm/aaaa"]').first();
  await input.click();
  await input.fill(`${d}/${m}/${y}`);
  // Tab commits the typed date (VueDatePicker tabSubmit) WITHOUT the Enter keypress that would
  // otherwise bubble to the surrounding <form> and submit it before a slot/time is chosen.
  await input.press('Tab');
}

// Fills a TimeField (masked input with custom keydown/@input handling — a plain .fill() bypasses the
// mask). Types the digits sequentially; the field auto-inserts the colon (e.g. '1000' → '10:00').
export async function fillTime(page: Page, id: string, hhmm: string): Promise<void> {
  const input = page.locator(`#${id}`);
  // Drive the value through the TimeField's own +/- hour/minute adjuster, whose handlers commit the
  // value directly (bypassing the masked-input reformatter that resists programmatic typing on a
  // PREFILLED field). Clicking the input opens the popover; then step hour/minute to the target.
  const [targetH, targetM] = hhmm.split(':').map(Number);
  await input.click(); // opens the adjuster popover
  const readPart = async (i: number) => {
    const v = await input.inputValue();
    return v.includes(':') ? Number(v.split(':')[i]) : 0;
  };
  const hourUp = page.getByRole('button', { name: '+ hora' });
  for (let guard = 0; guard < 24; guard++) {
    if ((await readPart(0)) === targetH) break;
    await hourUp.click();
  }
  const minUp = page.getByRole('button', { name: '+ minutos' });
  for (let guard = 0; guard < 12; guard++) {
    if ((await readPart(1)) === targetM) break;
    await minUp.click();
  }
  await input.blur();
  await expect(input).toHaveValue(hhmm, { timeout: 5_000 });
}

// Opens the calendar detail panel for an appointment, navigating the week grid to reach it.
export async function openAppointmentDetail(
  page: Page,
  id: number,
  direction: 'next' | 'prev' = 'next',
): Promise<void> {
  await page.getByRole('link', { name: 'Calendario' }).click();
  await expect(page.locator('.fc')).toBeVisible();
  await navigateCalendarToAppointment(page, id, 12, direction);
  await page.locator(`[data-testid="appt-${id}"]`).first().click();
  await expect(page.getByText('Detalle del turno')).toBeVisible({ timeout: 10_000 });
}
