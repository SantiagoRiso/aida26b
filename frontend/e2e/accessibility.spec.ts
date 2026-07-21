import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { login, DEMO_ACCOUNTS, openScreen, es } from './helpers';

const isPhoneWidth = ({ viewport }: { viewport: { width: number } | null }) =>
  (viewport?.width ?? 0) >= 768;

/**
 * One representative journey — login, then the Profesionales roster (ProfessionalsView, a direct
 * `<GenericTable>` consumer) — audited with axe-core. GenericTable is the shared widget behind
 * most staff list screens, so an a11y regression there (missing labels, contrast, landmark/heading
 * order) surfaces here without auditing every screen that embeds it.
 *
 * This is a smoke check for automatically detectable violations on the widget itself, not a full
 * manual WCAG audit of the app shell. The pre-login screen already has a known, pre-existing
 * finding (no <main> landmark around LoginView) that is unrelated to GenericTable and out of scope
 * here, so the audited page is the post-login destination, not the login form.
 */
test.describe('Accessibility (axe-core)', () => {
  test('the Profesionales roster (GenericTable) has no automatically detectable violations', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await openScreen(page, es.nav.professionals);
    await expect(page.locator('table')).toBeVisible({ timeout: 15_000 });

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  // Phone-width only: the drawer replaces the sidebar below the md breakpoint, so at desktop
  // width there is nothing to open and nothing to audit.
  test('the open navigation drawer has no automatically detectable violations', async ({ page }) => {
    test.skip(isPhoneWidth({ viewport: page.viewportSize() }), 'sidebar is permanent at this width');

    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('button', { name: es.nav.openMenu }).click();
    await expect(page.getByRole('dialog', { name: es.nav.menu })).toHaveCount(1);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
});
