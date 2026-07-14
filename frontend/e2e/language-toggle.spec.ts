import { test, expect } from '@playwright/test';
import { login, DEMO_ACCOUNTS, es } from './helpers';

test.describe('Language toggle', () => {
  test('settings screen shows the language toggle component', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('link', { name: es.nav.settings }).click();

    const toggle = page.getByTestId('language-toggle');
    await expect(toggle).toBeVisible();

    await expect(page.getByTestId('lang-es')).toBeVisible();
    await expect(page.getByTestId('lang-en')).toBeVisible();
  });

  test('SC3: clicking EN toggles nav label from "Calendario" to "Calendar" and back', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('link', { name: es.nav.settings }).click();

    await expect(page.getByRole('link', { name: es.nav.calendar })).toBeVisible();

    await page.getByTestId('lang-en').click();

    // exact:true prevents "Calendar" matching "Calendario" as a substring.
    await expect(page.getByRole('link', { name: 'Calendar', exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('link', { name: es.nav.calendar, exact: true })).not.toBeVisible();

    await page.getByTestId('lang-es').click();
    await expect(page.getByRole('link', { name: es.nav.calendar, exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('link', { name: 'Calendar', exact: true })).not.toBeVisible();
  });

  test('SC3: EN label also changes page heading from Spanish to English', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('link', { name: es.nav.settings }).click();

    const heading = page.locator('h1');
    await expect(heading).toContainText(es.nav.settings);

    await page.getByTestId('lang-en').click();
    await expect(heading).toContainText('Settings', { timeout: 5_000 });

    await page.getByTestId('lang-es').click();
    await expect(heading).toContainText(es.nav.settings, { timeout: 5_000 });
  });
});
