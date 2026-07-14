import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { DEMO_ACCOUNTS as DEMO_USERS, DEMO_PASSWORD } from '../../shared/src/dev-fixtures';

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
  await page.goto('/');
  await page.getByLabel('Usuario').fill(username);
  // #password (not getByLabel) — the show/hide toggle's aria-label also contains "Contraseña".
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15_000 });
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
): Promise<void> {
  const target = page.locator(`[data-testid="appt-${appointmentId}"]`);
  for (let i = 0; i < maxClicks; i++) {
    if (await target.first().isVisible().catch(() => false)) return;
    const nextFetch = page.waitForResponse(
      (r) => r.url().includes('/appointments') && r.request().method() === 'GET',
      { timeout: 10_000 },
    ).catch(() => null);
    await page.locator('.fc-next-button').click();
    await nextFetch;
  }
  await expect(target.first()).toBeVisible({ timeout: 10_000 });
}
