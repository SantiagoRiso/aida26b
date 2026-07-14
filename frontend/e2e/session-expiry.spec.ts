import { test, expect } from '@playwright/test';
import { login, DEMO_ACCOUNTS, es } from './helpers';

/**
 * The soft-redirect-on-expiry flow, verified against the real backend by clearing the session cookie
 * mid-session (a genuine 401, not a network intercept):
 *
 *  1. On the 401 that discovers the lapsed session, apiFetch calls ui.flagSessionExpired, which sets
 *     ui.sessionExpired AND pushes the `sessionExpired` toast (stores/ui.ts). The target view fires
 *     several authenticated GETs on mount (its list plus FK-option lookups), so multiple parallel
 *     401s each push their own toast — match by text, never a bare getByRole('alert').
 *
 *  2. The current view stays put when the flag is first set (soft redirect); the NEXT navigation is
 *     where the guard consumes ui.sessionExpired, clears the dead session's user (auth.$reset), and
 *     routes to /login. Clearing the user is what lets the redirect actually land on /login instead
 *     of the authenticated-at-/login rule bouncing it back to a role home.
 */
test.describe('Session expiry', () => {
  test('a 401 surfaces the sessionExpired toast, and the next navigation routes to /login', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.professionalUser.username, DEMO_ACCOUNTS.professionalUser.password);
    await page.getByRole('link', { name: es.nav.requests, exact: true }).click();
    await expect(page).toHaveURL(/\/staff\/requests/);

    await page.context().clearCookies();

    // A data-backed SPA navigation now 401s; apiFetch's interceptor pushes the sessionExpired toast
    // and the current view stays put (soft redirect).
    await page.getByRole('link', { name: es.nav.calendar, exact: true }).click();
    const expiredToast = page.getByRole('alert').filter({ hasText: es.toast.sessionExpired });
    await expect(expiredToast.first()).toBeVisible({ timeout: 10_000 });

    // The next navigation consumes the flag: the guard clears the stale user and redirects to /login.
    await page.getByRole('link', { name: es.nav.dashboard, exact: true }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});
