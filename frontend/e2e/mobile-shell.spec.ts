import { test, expect } from '@playwright/test';
import { login, DEMO_ACCOUNTS, es } from './helpers';

/**
 * Phone-width staff shell. Runs only in the `mobile` project (see playwright.config.mts) — at
 * desktop width the sidebar is permanent and none of this exists.
 */
test.describe('Staff shell on a phone', () => {
  test('the sidebar gives way to a drawer that navigates and dismisses itself', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    // Nav is out of the way until asked for: the links are not in the accessibility tree at all.
    await expect(page.getByRole('link', { name: es.nav.clients, exact: true })).toHaveCount(0);

    const trigger = page.getByRole('button', { name: es.nav.openMenu });
    await expect(trigger).toBeVisible();
    await trigger.click();

    const drawer = page.getByRole('dialog', { name: es.nav.menu });
    await expect(drawer).toHaveCount(1);
    await expect(drawer.getByRole('link', { name: es.nav.clients, exact: true })).toBeVisible();

    await drawer.getByRole('link', { name: es.nav.clients, exact: true }).click();

    await expect(page).toHaveURL(/\/staff\/clients/);
    // Navigating dismisses the drawer, otherwise it would cover the screen just requested.
    await expect(page.getByRole('dialog', { name: es.nav.menu })).toHaveCount(0);
  });

  test('escape dismisses the drawer and hands focus back to the menu button', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    const trigger = page.getByRole('button', { name: es.nav.openMenu });
    await trigger.click();
    await expect(page.getByRole('dialog', { name: es.nav.menu })).toHaveCount(1);

    await page.keyboard.press('Escape');

    await expect(page.getByRole('dialog', { name: es.nav.menu })).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('focus stays inside the drawer while it is open', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('button', { name: es.nav.openMenu }).click();
    await expect(page.getByRole('dialog', { name: es.nav.menu })).toHaveCount(1);

    // More tabs than the drawer has focusable children, so an untrapped focus ring would have
    // escaped into the page behind it by the end of the loop.
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() =>
        document.activeElement?.closest('[role="dialog"]') !== null,
      );
      expect(inside, `focus left the drawer after ${i + 1} tabs`).toBe(true);
    }
  });

  test('the drawer applies the same role filtering as the sidebar', async ({ page }) => {
    await login(
      page,
      DEMO_ACCOUNTS.professionalUser.username,
      DEMO_ACCOUNTS.professionalUser.password,
    );
    await page.getByRole('button', { name: es.nav.openMenu }).click();

    const drawer = page.getByRole('dialog', { name: es.nav.menu });
    await expect(drawer.getByRole('link', { name: es.nav.calendar, exact: true })).toBeVisible();
    await expect(drawer.getByRole('link', { name: es.nav.users, exact: true })).toHaveCount(0);
    await expect(drawer.getByRole('link', { name: es.nav.audit, exact: true })).toHaveCount(0);
  });

  // The portal is a different shell: a top nav over a centred column, and it already survived this
  // viewport. 320 is where its single header row used to run off the edge.
  test('the client portal header fits down to the narrowest handsets', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.client.username, DEMO_ACCOUNTS.client.password);
    await expect(page.getByRole('link', { name: es.nav.myBalance, exact: true })).toBeVisible();

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
    }
  });

  test('the main column is not pushed off screen', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    const main = page.locator('main');
    const box = await main.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    // The old shell handed 224 of 390 CSS pixels to a sidebar that could not be dismissed.
    expect(box!.width).toBeGreaterThan((viewport!.width * 9) / 10);
  });
});
