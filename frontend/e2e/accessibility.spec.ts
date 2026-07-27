import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { login, DEMO_ACCOUNTS, openScreen, es } from './helpers';
import { structure } from '../../shared/src/ssot/structure';

/**
 * axe-core coverage over the shared widgets the whole staff app is built from: the login form, a
 * data table (GenericTable), the filter row (GenericFilters), a dialog + form (DetailPanel +
 * the create-user form) and the mobile nav drawer. Auditing the shared widget once catches a
 * regression on every screen that embeds it, without paying to visit every screen.
 *
 * Every audit runs in both themes. Contrast is the one class of violation that is a property of
 * the palette rather than the markup, so a light-only audit is blind to half the product by
 * construction. Flipping data-theme is what the app itself does to repaint (see styles/theme.ts),
 * so it needs no reload: the extra cost is a second axe pass per screen (well under a second),
 * not a second navigation.
 *
 * Cost control: the desktop project audits all five subjects; the phone project re-runs only the
 * three whose layout genuinely differs at 390px. Navigation, not axe, is what costs wall clock
 * here, and every screen is reached through one login + one nav click.
 */

const isDesktopWidth = (page: Page) => (page.viewportSize()?.width ?? 0) >= 768;

// Mirrors applyTheme() in src/styles/theme.ts — the attribute is the whole repaint mechanism.
async function auditBothThemes(
  page: Page,
  build: (page: Page) => AxeBuilder = (p) => new AxeBuilder({ page: p }),
): Promise<void> {
  // Flipping data-theme repaints through `transition-colors`, so a colour animates from its light
  // value to its dark one over the transition window. axe reads the computed colour the instant the
  // attribute is set and would otherwise catch a control (e.g. the accent submit button) mid-fade and
  // report a contrast ratio that no settled state ever shows. Kill transitions so each repaint is
  // instantaneous and axe only ever sees a final, real colour pair.
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    const results = await build(page).analyze();
    expect(
      results.violations,
      `theme=${theme}\n${JSON.stringify(results.violations, null, 2)}`,
    ).toEqual([]);
  }
}

test.describe('Accessibility (axe-core)', () => {
  test('the login screen has no automatically detectable violations', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: es.actions.login })).toBeVisible({ timeout: 30_000 });

    await auditBothThemes(page, (p) => new AxeBuilder({ page: p }));
  });

  test('the Profesionales roster (GenericTable) has no automatically detectable violations', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await openScreen(page, es.nav.professionals);
    await expect(page.locator('table')).toBeVisible({ timeout: 15_000 });

    await auditBothThemes(page);
  });

  // An added filter row names its control only by the field label beside it, so a broken label
  // association shows up here. The referenced-id (combobox) variant of that row is the hardest
  // case, but the only foreign-key filter any generic screen offers is the business column, which
  // is now withheld from a business-bound admin — and no demo account is a super-admin. That
  // variant's label wiring is asserted in test/a11y-chrome.test.ts instead.
  test('an active filter row (GenericFilters) has no automatically detectable violations', async ({ page }) => {
    test.skip(!isDesktopWidth(page), 'audited once, at desktop width');

    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await openScreen(page, es.nav.users);
    await expect(page.locator('table')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('combobox', { name: es.generic.selectColumnAria }).selectOption('role');
    // exact: 'Agregar' is otherwise a substring of the page's 'Agregar usuario' create button.
    await page.getByRole('button', { name: es.generic.add, exact: true }).click();
    await expect(page.getByLabel(structure.tables.users.columns.role.label.es, { exact: true })).toBeVisible({ timeout: 10_000 });

    await auditBothThemes(page);
  });

  test('an open dialog with a form has no automatically detectable violations', async ({ page }) => {
    test.skip(!isDesktopWidth(page), 'audited once, at desktop width');

    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await openScreen(page, es.nav.users);
    await page.getByRole('button', { name: es.users.addUser }).click();
    await expect(page.getByRole('dialog', { name: es.users.newUser })).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator('#username')).toBeVisible({ timeout: 10_000 });

    await auditBothThemes(page);
  });

  // Phone-width only: the drawer replaces the sidebar below the md breakpoint, so at desktop
  // width there is nothing to open and nothing to audit.
  test('the open navigation drawer has no automatically detectable violations', async ({ page }) => {
    test.skip(isDesktopWidth(page), 'sidebar is permanent at this width');

    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('button', { name: es.nav.openMenu }).click();
    await expect(page.getByRole('dialog', { name: es.nav.menu })).toHaveCount(1);

    await auditBothThemes(page);
  });
});
