import { test, expect } from '@playwright/test';
import type { Page, APIRequestContext } from '@playwright/test';
import { login, DEMO_ACCOUNTS, openScreen, es } from './helpers';

/**
 * UsersView — Reset password / Deactivate (per-row, admin-only, never on your own row) and the
 * create-user server-error path. Basic create + the GET /api/users 200 listing are already covered
 * in staff-crud.spec.ts; this spec focuses on what that one doesn't touch.
 *
 * The seeded + prior-spec user count comfortably exceeds GenericTable's page size (20), so a fresh
 * row isn't reliably on page 1. Rather than hunt for it across pages, each test narrows the table
 * with the real GenericFilters UI (filter on the `username` column, which is `filterable`) down to
 * exactly the row under test — infrastructure for these tests, not a re-test of GenericFilters itself
 * (that's F19/P6 territory).
 */

async function createStaffUser(req: APIRequestContext, role: 'Receptionist', label: string): Promise<{ id: number; username: string; password: string }> {
  const tag = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const username = `e2e_p5_users_${tag}`;
  const password = 'e2e-secure-pass-789';
  const res = await req.post('/api/admin/users', {
    data: { username, email: `${username}@demo.test`, password, role, display_name: label },
  });
  const body = await res.json();
  if (!res.ok() || !body.data?.id) throw new Error(`create user failed: ${res.status()} ${JSON.stringify(body)}`);
  return { id: Number(body.data.id), username, password };
}

// Narrows the Usuarios GenericTable to rows whose username matches `value`, via the real
// "Agregar filtro" UI (not a query-string shortcut) so the row under test is deterministically on
// page 1 regardless of how many other users exist.
async function filterUsersByUsername(page: Page, value: string): Promise<void> {
  await page.getByRole('combobox', { name: es.generic.selectColumnAria }).selectOption('username');
  // exact: 'Agregar' is otherwise a substring of the page's 'Agregar usuario' create button.
  await page.getByRole('button', { name: es.generic.add, exact: true }).click();
  const valueInput = page.getByPlaceholder(es.generic.filterPlaceholder);
  const resp = page.waitForResponse((r) => r.url().includes('/api/users') && r.request().method() === 'GET', { timeout: 10_000 });
  await valueInput.fill(value);
  await resp;
}

async function openUsers(page: Page): Promise<void> {
  await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
  await openScreen(page, es.nav.users);
  await expect(page.locator('table')).toBeVisible({ timeout: 15_000 });
}

test.describe('Users CRUD (admin) — reset password, deactivate, isSelf, create error', () => {
  test('resets a password for another user (not self)', async ({ page }) => {
    // openUsers logs in (giving page.request its session cookie) before any API call; filtering
    // afterwards re-fetches the list so the freshly-created target is on page 1.
    await openUsers(page);
    const target = await createStaffUser(page.request, 'Receptionist', 'E2E P5 Users Reset');
    await filterUsersByUsername(page, target.username);

    const row = page.locator('tr').filter({ hasText: target.username });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByRole('button', { name: es.users.resetPassword }).click();

    const newPassword = 'e2e-reset-pass-456';
    await page.locator('#new-password').fill(newPassword);
    const resetResp = page.waitForResponse((r) => r.url().includes('/reset-password') && r.request().method() === 'POST', { timeout: 10_000 });
    await page.getByRole('button', { name: es.actions.save }).click();
    expect((await resetResp).ok()).toBe(true);

    // Durable: the new password actually works, independent of the admin's own session.
    const newCtx = await page.context().browser()!.newContext();
    const newPage = await newCtx.newPage();
    const loginRes = await newPage.request.post('/api/auth/login', {
      data: { username: target.username, password: newPassword },
    });
    expect(loginRes.status()).toBe(200);
    await newCtx.close();
  });

  test('deactivates another user after a destructive confirm', async ({ page }) => {
    await openUsers(page);
    const target = await createStaffUser(page.request, 'Receptionist', 'E2E P5 Users Deactivate');
    await filterUsersByUsername(page, target.username);

    const row = page.locator('tr').filter({ hasText: target.username });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByRole('button', { name: es.users.deactivate }).click();

    const dialog = page.getByRole('dialog').filter({ hasText: es.users.deactivateTitle });
    const deactivateResp = page.waitForResponse((r) => r.url().includes('/deactivate') && r.request().method() === 'POST', { timeout: 10_000 });
    await dialog.getByRole('button', { name: es.users.deactivate }).click();
    expect((await deactivateResp).ok()).toBe(true);

    // Deactivation is a soft delete (is_active=false + deleted_at stamped), so the user drops out of
    // the generic users read entirely — its absence is the durable proof, both in the API and in the
    // remounted (reloadKey) table after re-applying the filter.
    const after = await (await page.request.get(`/api/users?filter_username=${target.username}`)).json();
    expect((after.data ?? []).length).toBe(0);

    await filterUsersByUsername(page, target.username);
    await expect(page.locator('tr').filter({ hasText: target.username })).toHaveCount(0, { timeout: 10_000 });
  });

  test('isSelf hides Reset password and Desactivar on the admin\'s own row', async ({ page }) => {
    await openUsers(page);
    await filterUsersByUsername(page, DEMO_ACCOUNTS.adminUser.username);

    const row = page.locator('tr').filter({ hasText: DEMO_ACCOUNTS.adminUser.username });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.getByRole('button', { name: es.users.resetPassword })).toHaveCount(0);
    await expect(row.getByRole('button', { name: es.users.deactivate })).toHaveCount(0);
  });

  test('create shows a server error inline (duplicate username)', async ({ page }) => {
    await openUsers(page);
    await page.getByRole('button', { name: es.users.addUser }).click();

    // demo_admin already exists — the client performs no uniqueness check, so the server's 409
    // must surface into the form.
    await page.locator('#username').fill(DEMO_ACCOUNTS.adminUser.username);
    await page.locator('#email').fill(`dupe_${Date.now()}@demo.test`);
    await page.locator('#password').fill('e2e-secure-pass-789');
    await page.locator('#role').selectOption('Receptionist');
    await page.locator('#display_name').fill('E2E P5 Duplicate');

    const createResp = page.waitForResponse((r) => r.url().includes('/api/admin/users') && r.request().method() === 'POST', { timeout: 10_000 });
    await page.getByRole('button', { name: es.actions.save }).click();
    const resp = await createResp;
    expect(resp.ok()).toBe(false);

    await expect(page.getByRole('alert')).toBeVisible({ timeout: 10_000 });
    // The panel stays open on error — no navigation happened.
    await expect(page.locator('#username')).toBeVisible();
  });
});
