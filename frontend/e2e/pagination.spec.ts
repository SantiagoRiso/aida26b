import { test, expect } from '@playwright/test';
import { login, DEMO_ACCOUNTS, es } from './helpers';
// The search fields are labelled from the column descriptors, not from a UI string bundle.
import { structure } from '../../shared/src/ssot/structure';

/**
 * The seeded dataset has 30+ clients (demo_client1..33 plus the named `client`/`clientOverdue`
 * fixtures), which is under the server's default page size (LIST_DEFAULT_LIMIT, 50, in
 * shared/src/ssot/list-protocol.ts). The clients list binds its page/sort/filter state to the URL
 * (frontend/src/composables/useListQuerySync.ts), so these specs open it with an explicit
 * `?limit=10` — a real, user-reachable URL — to exercise the pagination UI against the seeded
 * dataset instead of waiting for it to grow past 50.
 *
 * Admin is used deliberately: the clients list hides clients a Professional/Receptionist has no
 * prior relationship with, which would make the visible row count depend on the seeded
 * appointment history.
 */
const CLIENTS_PAGED_URL = '/staff/clients?limit=10';

async function openClientsPaged(page: import('@playwright/test').Page) {
  await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
  await page.goto(CLIENTS_PAGED_URL);
  await expect(page.locator('table')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('tbody tr').first()).toBeVisible();
}

test.describe('Pagination', () => {
  test('clients list shows pagination controls when total > limit', async ({ page }) => {
    await openClientsPaged(page);

    await expect(page.locator('tbody tr')).toHaveCount(10);

    const prevBtn = page.getByRole('button', { name: es.generic.previous });
    const nextBtn = page.getByRole('button', { name: es.generic.next });

    await expect(page.getByText(es.generic.page, { exact: false })).toBeVisible();
    await expect(prevBtn).toBeDisabled();
    await expect(nextBtn).toBeEnabled();
  });

  test('clicking Siguiente navigates to page 2', async ({ page }) => {
    await openClientsPaged(page);

    const firstRowPage1 = await page.locator('tbody tr').first().textContent();

    await page.getByRole('button', { name: es.generic.next }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByRole('button', { name: es.generic.previous })).toBeEnabled();

    await expect
      .poll(() => page.locator('tbody tr').first().textContent())
      .not.toEqual(firstRowPage1);
  });

  test('clicking Anterior returns to page 1', async ({ page }) => {
    await openClientsPaged(page);

    const firstRowPage1 = await page.locator('tbody tr').first().textContent();

    const nextBtn = page.getByRole('button', { name: es.generic.next });
    const prevBtn = page.getByRole('button', { name: es.generic.previous });

    await nextBtn.click();
    await expect(page).toHaveURL(/page=2/);
    await expect(prevBtn).toBeEnabled();

    await prevBtn.click();
    // Page 1 is the default, so it leaves no page key behind.
    await expect(page).not.toHaveURL(/page=/);
    await expect(prevBtn).toBeDisabled();

    await expect
      .poll(() => page.locator('tbody tr').first().textContent())
      .toEqual(firstRowPage1);
  });

  test('backend meta envelope is correct for paginated response', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    const responsePromise = page.waitForResponse(
      (r) => r.url().includes('/api/clients') && r.request().method() === 'GET',
      { timeout: 15_000 },
    );
    await page.getByRole('link', { name: es.nav.clients }).click();
    const response = await responsePromise;

    const json = await response.json();

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

  test('the list requests only one page, never the whole table', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    const responsePromise = page.waitForResponse(
      (r) => r.url().includes('/api/clients') && r.request().method() === 'GET',
      { timeout: 15_000 },
    );
    await page.getByRole('link', { name: es.nav.clients }).click();
    const response = await responsePromise;

    const json = await response.json();
    expect(json.meta.limit).toBeLessThanOrEqual(50);
    expect(json.data.length).toBeLessThanOrEqual(json.meta.limit);
  });

  test('seeded clients list has 30+ records, and a smaller limit yields multiple pages', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    const defaultRes = await page.request.get('/api/clients');
    const defaultJson = await defaultRes.json();
    expect(defaultJson.meta.total).toBeGreaterThan(20);

    const smallLimitRes = await page.request.get('/api/clients?limit=10');
    const smallLimitJson = await smallLimitRes.json();
    expect(smallLimitJson.meta.limit).toBe(10);
    expect(smallLimitJson.meta.total).toBe(defaultJson.meta.total);

    const totalPages = Math.ceil(smallLimitJson.meta.total / smallLimitJson.meta.limit);
    expect(totalPages).toBeGreaterThan(1);
  });

  test('the clients search narrows the list server-side', async ({ page }) => {
    await openClientsPaged(page);

    // Search for a name the seeded dataset is known to contain: the one on screen.
    const firstName = (await page.locator('tbody tr td').first().innerText()).trim();
    expect(firstName.length).toBeGreaterThan(0);

    const responsePromise = page.waitForResponse(
      (r) => r.url().includes('filter_display_name=') && r.request().method() === 'GET',
      { timeout: 15_000 },
    );
    await page.getByLabel(structure.tables.clients.columns.display_name.label.es).fill(firstName);
    const response = await responsePromise;
    const json = await response.json();

    // The narrowing happened on the server: the response itself carries only matches.
    expect(json.meta.total).toBeGreaterThanOrEqual(1);
    expect(json.data.length).toBeLessThanOrEqual(json.meta.limit);
    for (const row of json.data) {
      expect(String(row.display_name).toLowerCase()).toContain(firstName.toLowerCase());
    }
    await expect(page).toHaveURL(/filter_display_name=/);
  });
});
