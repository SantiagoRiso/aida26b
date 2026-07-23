import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { DEMO_ACCOUNTS, es } from './helpers';

/**
 * demo_reset is the SOLE consumer of the must_change_password=true seed flag — only
 * one spec logs in as demo_reset.
 *
 * The last test here mutates demo_reset's password. In CI the Postgres service is
 * ephemeral so the test is always fresh; locally, re-seed before re-running, or run
 * this as part of the full sequential suite (workers:1) which seeds once up front.
 * The seed:demo script's ON CONFLICT DO UPDATE does NOT reset password_hash, to avoid
 * overwriting legitimate production passwords.
 *
 * Retries are forced off for this describe (below), overriding the CI-wide retries:2.
 * The mutation is one-way: once the third test changes demo_reset's password, the seed
 * precondition is gone. With retries on, a failure AFTER that change would retry, the
 * retry would log in with the now-stale seed password, `ok` would be false, and
 * test.skip(!ok) would launder the real failure into a skip — a green build over a
 * genuine regression in the forced-change flow. No retry means such a failure fails loudly.
 */

async function loginAsDemoReset(page: Page) {
  await page.goto('/');
  await page.getByLabel(es.auth.usernameLabel).fill(DEMO_ACCOUNTS.forcedResetUser.username);
  // #password (not getByLabel) — the show/hide toggle's aria-label also contains "Contraseña".
  await page.locator('#password').fill(DEMO_ACCOUNTS.forcedResetUser.password);
  await page.getByRole('button', { name: es.actions.login }).click();

  await page.waitForTimeout(2000);

  const url = page.url();
  const credError = page.locator('text=Credenciales inválidas');
  const hasCredError = await credError.isVisible().catch(() => false);

  if (hasCredError || url.includes('/login')) {
    return false; // login failed — password was already changed
  }

  return true;
}

// The seeded demo_reset password is a precondition of this suite, not a coin flip: the two
// read-only specs below assert it rather than skipping, so a stale DB fails loudly.
const STALE_SEED_HINT =
  'demo_reset login failed — its password was already changed by a prior run. ' +
  'Re-seed (`npm run seed:demo --prefix backend`) against a fresh test DB. ' +
  'In CI this spec always starts fresh (ephemeral Postgres per job).';

test.describe('Forced password change', () => {
  // A one-way password mutation makes retries unsafe here: a retry after the change would
  // re-log-in with the stale seed password and skip, converting a real failure into a pass.
  test.describe.configure({ retries: 0 });

  test('demo_reset logs in and is immediately routed to ChangePasswordView', async ({ page }) => {
    const ok = await loginAsDemoReset(page);
    expect(ok, STALE_SEED_HINT).toBe(true);

    await page.waitForURL(/\/change-password/, { timeout: 10_000 });

    const banner = page.getByText(es.auth.mustChangeBanner);
    await expect(banner).toBeVisible();

    await expect(page.getByLabel(es.auth.currentPasswordLabel)).toBeVisible();
    await expect(page.getByLabel(es.auth.newPasswordLabel)).toBeVisible();
  });

  test('ChangePasswordView fills the entire screen — no sidebar nav visible when forced', async ({ page }) => {
    const ok = await loginAsDemoReset(page);
    expect(ok, STALE_SEED_HINT).toBe(true);

    await page.waitForURL(/\/change-password/, { timeout: 10_000 });

    // ChangePasswordView is full-screen with no sidebar nav — the sidebar that appears
    // in StaffLayout for normal staff access must NOT be present.
    const sidebarLink = page.getByRole('link', { name: es.nav.calendar, exact: true });
    await expect(sidebarLink).not.toBeVisible();

    await expect(page.getByText(es.auth.mustChangeBanner)).toBeVisible();
    await expect(page.getByLabel(es.auth.currentPasswordLabel)).toBeVisible();
    await expect(page.getByLabel(es.auth.newPasswordLabel)).toBeVisible();

    await expect(page).toHaveURL(/\/change-password/);
  });

  test('demo_reset changes password and reaches staff dashboard', async ({ page }) => {
    const ok = await loginAsDemoReset(page);
    // This is the spec that consumes the seeded password, so a second run without a re-seed
    // genuinely cannot exercise it — reported as a skip, never as a pass.
    test.skip(!ok, STALE_SEED_HINT);

    await page.waitForURL(/\/change-password/, { timeout: 10_000 });

    await page.getByLabel(es.auth.currentPasswordLabel).fill(DEMO_ACCOUNTS.forcedResetUser.password);

    // New password must be at least 8 characters.
    const newPassword = 'new-secure-pass-456';
    await page.getByLabel(es.auth.newPasswordLabel).fill(newPassword);

    await page.getByRole('button', { name: es.actions.changePassword }).click();

    // demo_reset is a Professional — routes to /staff/dashboard once the flag clears.
    await page.waitForURL(/\/staff\//, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/staff\//);

    await expect(page.getByRole('link', { name: es.nav.calendar, exact: true })).toBeVisible();
  });
});
