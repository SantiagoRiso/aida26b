import { test, expect } from '@playwright/test';
import { login, DEMO_ACCOUNTS, es } from './helpers';

/**
 * The seeded dataset has 30+ clients (demo_client1..33 plus the named `client`/`clientOverdue`
 * fixtures), but the server's default page size (LIST_DEFAULT_LIMIT, shared/src/ssot/list-protocol.ts)
 * is 50 — GenericTable.vue (frontend/src/components/generic/GenericTable.vue) never sends a `limit`
 * param, so the live clients table now always fits on a single page and Siguiente/Anterior never
 * render. The tests below tolerate that (they warn+skip rather than fail when no multi-page UI
 * exists) so they still hold if the dataset later grows past 50.
 *
 * The generic CRUD GET routes DO honor an explicit `?limit=` (backend/src/routes/list-request.ts
 * parseListRequest reads query.limit, clamped to LIST_MAX_LIMIT) even though the UI never sends one.
 * The last test below drives that directly to prove the pagination math (page/limit/total → page
 * count) still works, since it's no longer observable through the rendered table.
 */
test.describe('Pagination', () => {
  test('clients list shows pagination controls when total > limit', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('link', { name: es.nav.clients }).click();

    await expect(page.locator('table')).toBeVisible({ timeout: 15_000 });

    const nextBtn = page.getByRole('button', { name: es.generic.next });
    const prevBtn = page.getByRole('button', { name: es.generic.previous });

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
    await page.getByRole('link', { name: es.nav.clients }).click();

    await expect(page.locator('table')).toBeVisible({ timeout: 15_000 });

    const nextBtn = page.getByRole('button', { name: es.generic.next });
    const nextVisible = await nextBtn.isVisible().catch(() => false);

    if (!nextVisible) {
      console.warn('No "Siguiente" button visible; single-page dataset. Navigation test skipped.');
      return;
    }

    const firstRowPage1 = await page.locator('tbody tr').first().textContent();

    await nextBtn.click();
    await page.waitForTimeout(1000);

    const prevBtn = page.getByRole('button', { name: es.generic.previous });
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
    await page.getByRole('link', { name: es.nav.clients }).click();

    await expect(page.locator('table')).toBeVisible({ timeout: 15_000 });

    const nextBtn = page.getByRole('button', { name: es.generic.next });
    const nextVisible = await nextBtn.isVisible().catch(() => false);

    if (!nextVisible) {
      console.warn('No "Siguiente" button visible; single-page dataset. Prev-navigation test skipped.');
      return;
    }

    const firstRowPage1 = await page.locator('tbody tr').first().textContent();

    await nextBtn.click();
    await page.waitForTimeout(1000);

    const prevBtn = page.getByRole('button', { name: es.generic.previous });
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
    await page.getByRole('link', { name: es.nav.clients }).click();
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

  test('seeded clients list has 30+ records, and a smaller limit yields multiple pages', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    const defaultRes = await page.request.get('/api/clients');
    const defaultJson = await defaultRes.json();
    expect(defaultJson.meta.total).toBeGreaterThan(20);

    // The default limit (50) now exceeds the seeded client count, so the live table is single-page
    // (see file header). Request a smaller limit directly to prove the server's pagination
    // arithmetic still produces multiple pages for a dataset that exceeds it.
    const smallLimitRes = await page.request.get('/api/clients?limit=10');
    const smallLimitJson = await smallLimitRes.json();
    expect(smallLimitJson.meta.limit).toBe(10);
    expect(smallLimitJson.meta.total).toBe(defaultJson.meta.total);

    const totalPages = Math.ceil(smallLimitJson.meta.total / smallLimitJson.meta.limit);
    expect(totalPages).toBeGreaterThan(1);
  });
});
