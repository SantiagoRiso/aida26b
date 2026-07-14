import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { login, DEMO_ACCOUNTS, es } from './helpers';

/**
 * router/index.ts's beforeEach, exercised through the real app rather than the synthetic router
 * in router-guards.test.ts (unit). Four branches: unauthenticated -> login; authed hitting /login
 * -> role redirect; role-denied route -> notPermitted toast + `return false` (stays put); the
 * wildcard catch-all -> /login. Logout in both layouts clears the session so the next protected
 * nav bounces again.
 */

// SidebarNav/PortalNav never render a link a role can't use, so there is no click path into a
// denied route to drive "stays put" — and a hard page.goto() to a denied URL would reload the
// whole SPA, destroying the very "still on the previous page" state the assertion needs. Instead
// drive an SPA-internal navigation the same way a browser back/forward button would: push history
// state and dispatch the popstate vue-router's createWebHistory listens for. A cancelled guard
// then resolves exactly as router-guards.test.ts asserts at the unit level: toast, and the router
// stays on the confirmed route.
async function navigateInSpa(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

// The deterministic half of "role-denied" is that the SPA never reaches the staff route: the URL
// stays on the origin (guard returned false) and the origin layout is still mounted. The toast is
// a secondary signal and must be matched by TEXT — a bare getByRole('alert') strict-mode-fails
// whenever the origin view renders its own alert (e.g. the portal's cancel-cutoff banner, which
// only appears for some seeded-data states, hence the isolation-vs-full-suite flakiness).
const notPermittedToast = (page: Page) =>
  page.getByRole('alert').filter({ hasText: es.toast.notPermitted });

test.describe('Routing guards — unauthenticated', () => {
  test('a protected staff route redirects to /login', async ({ page }) => {
    await page.goto('/staff/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });

  test('a protected portal route redirects to /login', async ({ page }) => {
    await page.goto('/portal/balance');
    await expect(page).toHaveURL(/\/login/);
  });

  test('an unknown path redirects to /login via the wildcard catch-all', async ({ page }) => {
    await page.goto('/this/route/does/not/exist');
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('Routing guards — authenticated hitting /login', () => {
  test('a staff role is bounced from /login to the staff dashboard', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.goto('/login');
    await expect(page).toHaveURL(/\/staff\/dashboard/);
  });

  test('a Client is bounced from /login to the portal', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.client.username, DEMO_ACCOUNTS.client.password);
    await page.goto('/login');
    await expect(page).toHaveURL(/\/portal\/appointments/);
  });

  test('an authenticated user hitting an unknown path lands on their role home, not /login', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.professionalUser.username, DEMO_ACCOUNTS.professionalUser.password);
    await page.goto('/this/route/does/not/exist');
    // The wildcard redirects to /login first; the "already authed at /login" branch immediately
    // re-redirects to the role's home, so the net effect for a logged-in user is the dashboard.
    await expect(page).toHaveURL(/\/staff\/dashboard/);
  });
});

test.describe('Routing guards — role-denied route', () => {
  test('a Professional hitting an Admin-only route gets notPermitted and stays on the dashboard', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.professionalUser.username, DEMO_ACCOUNTS.professionalUser.password);
    await expect(page).toHaveURL(/\/staff\/dashboard/);

    await navigateInSpa(page, '/staff/users');

    // Primary invariant (deterministic): the guard denied — never reached /staff/users, and the
    // dashboard is still mounted (a real navigation there would have swapped the sidebar content).
    await expect(page).toHaveURL(/\/staff\/dashboard/);
    await expect(page.getByRole('link', { name: es.nav.calendar, exact: true })).toBeVisible();
    // Secondary signal: the notPermitted toast (matched by text, tolerant of any other alerts).
    await expect(notPermittedToast(page).first()).toBeVisible({ timeout: 10_000 });
  });

  test('a Client hitting a staff route gets notPermitted and stays in the portal', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.client.username, DEMO_ACCOUNTS.client.password);
    await expect(page).toHaveURL(/\/portal\/appointments/);

    await navigateInSpa(page, '/staff/dashboard');

    // Primary invariant (deterministic): the Client never reached the staff route — URL stays in
    // the portal and the portal nav is still mounted (the staff shell never took over).
    await expect(page).toHaveURL(/\/portal\/appointments/);
    await expect(page.getByRole('link', { name: es.nav.myAppointments })).toBeVisible();
    // Secondary signal: the notPermitted toast, matched by text so a portal cancel-cutoff banner
    // (another role="alert") can't strict-mode-collide with it.
    await expect(notPermittedToast(page).first()).toBeVisible({ timeout: 10_000 });
  });

  test('a Receptionist hitting the Admin-only Negocio route gets notPermitted', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.receptionistWithGrant.username, DEMO_ACCOUNTS.receptionistWithGrant.password);
    await expect(page).toHaveURL(/\/staff\/dashboard/);

    await navigateInSpa(page, '/staff/business');

    // Primary invariant (deterministic): the guard denied — the Receptionist stayed on the dashboard.
    await expect(page).toHaveURL(/\/staff\/dashboard/);
    await expect(page.getByRole('link', { name: es.nav.calendar, exact: true })).toBeVisible();
    // Secondary signal: the notPermitted toast (matched by text).
    await expect(notPermittedToast(page).first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Routing guards — logout', () => {
  test('logout from the staff layout returns to login and the cleared session blocks re-entry', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('button', { name: es.nav.logout }).click();
    await expect(page).toHaveURL(/\/login/);

    await page.goto('/staff/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });

  test('logout from the portal layout returns to login and the cleared session blocks re-entry', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.client.username, DEMO_ACCOUNTS.client.password);
    await page.getByRole('button', { name: es.nav.logout }).click();
    await expect(page).toHaveURL(/\/login/);

    await page.goto('/portal/balance');
    await expect(page).toHaveURL(/\/login/);
  });
});
