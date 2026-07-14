import { test, expect } from '@playwright/test';
import { login, DEMO_ACCOUNTS, es } from './helpers';

/**
 * Login routes staff roles to the staff dashboard and clients to their portal —
 * LoginView.vue branches purely on auth.user.role, so one staff role and Client
 * cover the routing logic (staff-nav.spec.ts separately covers per-role nav visibility).
 */
test.describe('Login routing by role', () => {
  test('a staff role (Admin) lands on the staff dashboard', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await expect(page).toHaveURL(/\/staff\/dashboard/);
    await expect(page.getByRole('link', { name: es.nav.calendar, exact: true })).toBeVisible();
  });

  test('Client role lands on the portal appointments view, not the staff area', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.client.username, DEMO_ACCOUNTS.client.password);
    await expect(page).toHaveURL(/\/portal\/appointments/);
    await expect(page.getByRole('link', { name: es.nav.myAppointments })).toBeVisible();

    // Negative check: the staff sidebar's Admin-only links must never render for a client.
    await expect(page.getByRole('link', { name: es.nav.users })).not.toBeVisible();
  });
});
