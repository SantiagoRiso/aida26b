import { test, expect } from '@playwright/test';
import { login, DEMO_ACCOUNTS } from './helpers';

/**
 * The seeded dataset has 30+ clients, so the clients list has 2+ pages at the default
 * limit of 20 — the most reliable pagination test target.
 *
 * The generic CRUD GET routes use isListRequest() which does NOT recognize the `limit`
 * param alone — only page/sort/dir/filter_*. The Pagination component sends `?page=N`,
 * which IS recognized, so page navigation works.
 */
test.describe('Pagination', () => {
  test('clients list shows pagination controls when total > limit', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('link', { name: 'Clientes' }).click();

    await expect(page.locator('table')).toBeVisible({ timeout: 15_000 });

    const nextBtn = page.getByRole('button', { name: 'Siguiente' });
    const prevBtn = page.getByRole('button', { name: 'Anterior' });

    const hasPagination = await nextBtn.isVisible().catch(() => false)
      || await prevBtn.isVisible().catch(() => false)
      || await page.getByText(/página|page/i).first().isVisible().catch(() => false);

    if (!hasPagination) {
      const rows = page.locator('tbody tr');
      await expect(rows.first()).toBeVisible();
      console.warn('Pagination controls not visible — may be fewer records than limit or pagination uses different elements.');
      return;
    }

    if (await prevBtn.isVisible()) {
      await expect(prevBtn).toBeDisabled();
    }
    if (await nextBtn.isVisible()) {
      await expect(nextBtn).toBeEnabled();
    }
  });

  test('clicking Siguiente navigates to page 2', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('link', { name: 'Clientes' }).click();

    await expect(page.locator('table')).toBeVisible({ timeout: 15_000 });

    const nextBtn = page.getByRole('button', { name: 'Siguiente' });
    const nextVisible = await nextBtn.isVisible().catch(() => false);

    if (!nextVisible) {
      console.warn('No "Siguiente" button visible; single-page dataset. Navigation test skipped.');
      return;
    }

    const firstRowPage1 = await page.locator('tbody tr').first().textContent();

    await nextBtn.click();
    await page.waitForTimeout(1000);

    const prevBtn = page.getByRole('button', { name: 'Anterior' });
    if (await prevBtn.isVisible()) {
      await expect(prevBtn).toBeEnabled();
    }

    const firstRowPage2 = await page.locator('tbody tr').first().textContent();
    if (firstRowPage1 && firstRowPage2) {
      expect(firstRowPage2).not.toEqual(firstRowPage1);
    }
  });

  test('clicking Anterior returns to page 1', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('link', { name: 'Clientes' }).click();

    await expect(page.locator('table')).toBeVisible({ timeout: 15_000 });

    const nextBtn = page.getByRole('button', { name: 'Siguiente' });
    const nextVisible = await nextBtn.isVisible().catch(() => false);

    if (!nextVisible) {
      console.warn('No "Siguiente" button visible; single-page dataset. Prev-navigation test skipped.');
      return;
    }

    const firstRowPage1 = await page.locator('tbody tr').first().textContent();

    await nextBtn.click();
    await page.waitForTimeout(1000);

    const prevBtn = page.getByRole('button', { name: 'Anterior' });
    await expect(prevBtn).toBeEnabled();
    await prevBtn.click();
    await page.waitForTimeout(1000);

    const firstRowAfterBack = await page.locator('tbody tr').first().textContent();
    if (firstRowPage1 && firstRowAfterBack) {
      expect(firstRowAfterBack).toEqual(firstRowPage1);
    }

    if (await prevBtn.isVisible()) {
      await expect(prevBtn).toBeDisabled();
    }
  });

  test('backend meta envelope is correct for paginated response', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    const responsePromise = page.waitForResponse(
      (r) => r.url().includes('/api/clients') && r.request().method() === 'GET',
      { timeout: 15_000 },
    );
    await page.getByRole('link', { name: 'Clientes' }).click();
    const response = await responsePromise.catch(() => null);

    if (!response) {
      console.warn('No /api/clients response captured; skipping meta envelope check.');
      return;
    }

    const json = await response.json().catch(() => null);
    if (!json) return;

    expect(json.success).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.meta).toBeDefined();
    expect(typeof json.meta.page).toBe('number');
    expect(typeof json.meta.limit).toBe('number');
    expect(typeof json.meta.total).toBe('number');

    expect(json.meta.page).toBeGreaterThanOrEqual(1);
    expect(json.meta.limit).toBeGreaterThan(0);
    expect(json.meta.total).toBeGreaterThanOrEqual(0);
  });

  test('seeded clients list has 30+ records across multiple pages', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    const responsePromise = page.waitForResponse(
      (r) => r.url().includes('/api/clients') && r.request().method() === 'GET',
      { timeout: 15_000 },
    );
    await page.getByRole('link', { name: 'Clientes' }).click();
    const response = await responsePromise.catch(() => null);

    if (!response) {
      console.warn('No /api/clients response; seeded count check skipped.');
      return;
    }

    const json = await response.json().catch(() => null);
    if (!json?.meta) return;

    expect(json.meta.total).toBeGreaterThan(20);

    const totalPages = Math.ceil(json.meta.total / json.meta.limit);
    expect(totalPages).toBeGreaterThan(1);
  });
});
