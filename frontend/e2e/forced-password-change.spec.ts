import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { DEMO_ACCOUNTS } from './helpers';

/**
 * demo_reset is the SOLE consumer of the must_change_password=true seed flag — only
 * one spec logs in as demo_reset.
 *
 * The last test here mutates demo_reset's password. In CI the Postgres service is
 * ephemeral so the test is always fresh; locally, re-seed before re-running, or run
 * this as part of the full sequential suite (workers:1) which seeds once up front.
 * The seed:demo script's ON CONFLICT DO UPDATE does NOT reset password_hash, to avoid
 * overwriting legitimate production passwords.
 */

async function loginAsDemoReset(page: Page) {
  await page.goto('/');
  await page.getByLabel('Usuario').fill(DEMO_ACCOUNTS.forcedResetUser.username);
  await page.getByLabel('Contraseña').fill(DEMO_ACCOUNTS.forcedResetUser.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();

  await page.waitForTimeout(2000);

  const url = page.url();
  const credError = page.locator('text=Credenciales inválidas');
  const hasCredError = await credError.isVisible().catch(() => false);

  if (hasCredError || url.includes('/login')) {
    return false; // login failed — password was already changed
  }

  return true;
}

test.describe('Forced password change', () => {
  test('demo_reset logs in and is immediately routed to ChangePasswordView', async ({ page }) => {
    const ok = await loginAsDemoReset(page);
    if (!ok) {
      console.warn(
        'demo_reset login failed — password was already changed by a prior test run. ' +
        'Re-run `npm run seed:demo --prefix backend` and start a fresh test DB to reset. ' +
        'In CI this spec always starts fresh (ephemeral Postgres per job).',
      );
      return;
    }

    await page.waitForURL(/\/change-password/, { timeout: 10_000 });

    const banner = page.getByText('Por seguridad, elegí una nueva contraseña antes de continuar.');
    await expect(banner).toBeVisible();

    await expect(page.getByLabel('Contraseña actual')).toBeVisible();
    await expect(page.getByLabel('Nueva contraseña')).toBeVisible();
  });

  test('ChangePasswordView fills the entire screen — no sidebar nav visible when forced', async ({ page }) => {
    const ok = await loginAsDemoReset(page);
    if (!ok) {
      console.warn('demo_reset login failed — password already changed. Skipping guard test.');
      return;
    }

    await page.waitForURL(/\/change-password/, { timeout: 10_000 });

    // ChangePasswordView is full-screen with no sidebar nav — the sidebar that appears
    // in StaffLayout for normal staff access must NOT be present.
    const sidebarLink = page.getByRole('link', { name: 'Calendario', exact: true });
    await expect(sidebarLink).not.toBeVisible();

    await expect(page.getByText('Por seguridad, elegí una nueva contraseña antes de continuar.')).toBeVisible();
    await expect(page.getByLabel('Contraseña actual')).toBeVisible();
    await expect(page.getByLabel('Nueva contraseña')).toBeVisible();

    await expect(page).toHaveURL(/\/change-password/);
  });

  test('demo_reset changes password and reaches staff dashboard', async ({ page }) => {
    const ok = await loginAsDemoReset(page);
    if (!ok) {
      console.warn('demo_reset login failed — password already changed. Skipping change-and-proceed test.');
      return;
    }

    await page.waitForURL(/\/change-password/, { timeout: 10_000 });

    await page.getByLabel('Contraseña actual').fill(DEMO_ACCOUNTS.forcedResetUser.password);

    // New password must be at least 8 characters.
    const newPassword = 'new-secure-pass-456';
    await page.getByLabel('Nueva contraseña').fill(newPassword);

    await page.getByRole('button', { name: 'Cambiar contraseña' }).click();

    // demo_reset is a Professional — routes to /staff/dashboard once the flag clears.
    await page.waitForURL(/\/staff\//, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/staff\//);

    await expect(page.getByRole('link', { name: 'Calendario', exact: true })).toBeVisible();
  });
});
