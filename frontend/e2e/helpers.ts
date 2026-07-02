import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

// Demo/local-only credentials. These constants exist in one place so the demo seed
// script (backend/src/seed-demo.ts) can align exact usernames here; keep them in sync.
// These are never real secrets — they identify dev/demo accounts only.

export const DEMO_ACCOUNTS = {
  adminUser:           { username: 'demo_admin',         password: 'demo-pass-123', role: 'Admin' },
  professionalUser:    { username: 'demo_pro',           password: 'demo-pass-123', role: 'Professional' },
  receptionistWithGrant: { username: 'demo_recep',       password: 'demo-pass-123', role: 'Receptionist' },
  client:              { username: 'demo_client',        password: 'demo-pass-123', role: 'Client' },
  clientOverdue:       { username: 'demo_client_overdue', password: 'demo-pass-123', role: 'Client' },
  // The ONLY seeded must_change_password account — consumed by forced-password-change.spec.ts only.
  forcedResetUser:     { username: 'demo_reset',         password: 'demo-pass-123', role: 'Professional' },
} as const;

// Logs in via the real login screen, not the API directly.
export async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Usuario').fill(username);
  await page.getByLabel('Contraseña').fill(password);
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
