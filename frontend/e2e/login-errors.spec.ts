import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { DEMO_ACCOUNTS, es } from './helpers';

/**
 * LoginView's inline error is deliberately generic — it never confirms which of
 * username/password was wrong — and only distinguishes a 401 (bad credentials) from anything
 * else (server/network trouble): see LoginView.vue submit(). The 401 case drives the real
 * backend with a wrong password. The 500/network cases intercept the login POST — the real
 * backend has no on-demand way to fail, and this still exercises the actual fetch() promise the
 * client depends on (rejection for the network case, a non-401 error envelope for the 500 case).
 */
async function fillLoginForm(page: Page, username: string, password: string) {
  await page.goto('/');
  const submit = page.getByRole('button', { name: es.actions.login });
  await submit.waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByLabel(es.auth.usernameLabel).fill(username);
  await page.locator('#password').fill(password);
  return submit;
}

test.describe('Login errors — 401 invalid credentials', () => {
  test('wrong password shows the generic invalidCredentials message with red borders on both fields', async ({ page }) => {
    const submit = await fillLoginForm(page, DEMO_ACCOUNTS.adminUser.username, 'not-the-right-password');
    const authResponse = page.waitForResponse(
      (r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST',
      { timeout: 20_000 },
    );
    await submit.click();
    await authResponse;

    await expect(page.getByRole('alert')).toContainText(es.toast.invalidCredentials);
    await expect(page.locator('#username')).toHaveClass(/border-destructive/);
    await expect(page.locator('#password')).toHaveClass(/border-destructive/);
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('Login errors — 500 / network → serverUnavailable', () => {
  test('a 500 from the server shows serverUnavailable, not invalidCredentials', async ({ page }) => {
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: { code: 'internal', message: 'boom' } }),
      }),
    );

    const submit = await fillLoginForm(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await submit.click();

    await expect(page.getByRole('alert')).toContainText(es.toast.serverUnavailable);
    await expect(page).toHaveURL(/\/login/);
  });

  test('a network failure (request aborted before any response) also shows serverUnavailable', async ({ page }) => {
    await page.route('**/api/auth/login', (route) => route.abort());

    const submit = await fillLoginForm(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await submit.click();

    await expect(page.getByRole('alert')).toContainText(es.toast.serverUnavailable);
  });
});

test.describe('Login errors — loading state', () => {
  test('the submit button is aria-busy while the request is in flight', async ({ page }) => {
    await page.route('**/api/auth/login', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.continue();
    });

    const submit = await fillLoginForm(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await submit.click();

    await expect(submit).toHaveAttribute('aria-busy', 'true');
  });
});
