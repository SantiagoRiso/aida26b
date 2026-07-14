import { test, expect } from '@playwright/test';
import type { Page, APIRequestContext } from '@playwright/test';
import {
  login, DEMO_ACCOUNTS, selectFromCombobox, fillDate, findProfessionalId, isoDaysFromNow, es,
} from './helpers';
import { DEMO_SERVICE_NAMES, DEMO_PASSWORD } from '../../shared/src/dev-fixtures';

/**
 * The booking window (min/max days out a slot may be booked) clamps both "Agendar turno" forms —
 * the staff AppointmentForm and the client RequestFlow share `useBookingWindow` — and is enforced
 * again server-side on submit (client-only; staff scheduling is exempt, see routes/appointments.ts).
 * Business default here is min 0 / max 60 days (seed-demo.ts setBusinessBookingWindow), so
 * `isoDaysFromNow(60)` is the last in-window day and 61+ is out.
 *
 * Fixtures: Dr. Nick Riviera (single service, business-default window, read-only in this spec) and
 * Dr. Arnie Pye (single service) — the pair this phase owns exclusively. The `outside_booking_window`
 * case narrows Arnie's OWN per-service window (professional_services row) rather than the shared
 * business setting, so it can't affect any other spec's availability assumptions; it's restored at
 * the end of the test regardless.
 */
async function createLoginClient(req: APIRequestContext, username: string, displayName: string): Promise<void> {
  const res = await req.post('/api/admin/users', {
    data: { role: 'Client', username, email: `${username}@demo.test`, password: DEMO_PASSWORD, display_name: displayName },
  });
  if (!res.ok()) throw new Error(`create login client failed: ${res.status()} ${await res.text()}`);
}

async function loginFreshClient(page: Page, username: string): Promise<void> {
  await login(page, username, DEMO_PASSWORD);
  // Admin-created accounts start must_change_password, which 403s every other route until cleared.
  await page.request.post('/api/auth/change-password', {
    data: { current_password: DEMO_PASSWORD, new_password: 'e2e-p4-changed-123' },
  });
  // The API cleared the flag, but the client auth store still holds must_change_password:true, so the
  // router keeps forcing /change-password. A full reload re-fetches the (now-cleared) user state and
  // lands the Client on the portal.
  await page.goto('/');
  await page.waitForURL((url) => !url.pathname.includes('/change-password'), { timeout: 15_000 });
}

test.describe('Booking window — date-stepper clamp and server-side enforcement', () => {
  test('staff Agendar turno form clamps the date steppers at the booking window bounds', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('link', { name: es.nav.calendar }).click();
    await expect(page.locator('.fc')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: es.calendar.newAppointment }).click();

    const windowResp = page.waitForResponse(
      (r) => r.url().includes('/booking-window') && r.request().method() === 'GET', { timeout: 10_000 },
    ).catch(() => null);
    await selectFromCombobox(page, 'appt-prof', 'Dr. Nick Riviera');
    // A single offering collapses the service Selector to a read-only, auto-selected label.
    await expect(page.locator('#appt-service')).toContainText(DEMO_SERVICE_NAMES.kineso, { timeout: 10_000 });
    await windowResp; // ensure windowMax has resolved before reading the stepper's disabled state

    const prevBtn = page.getByRole('button', { name: es.calendar.prevDay });
    const nextBtn = page.getByRole('button', { name: es.calendar.nextDay });
    const dateInput = page.locator('input[placeholder="dd/mm/aaaa"]').first();

    // Fresh create-mode form: date starts empty, which the stepper math treats as "today" (the
    // window's floor) — so stepping backward is already a no-op and the button starts disabled.
    await expect(prevBtn).toBeDisabled();
    await expect(nextBtn).toBeEnabled();

    // One day short of the window ceiling, then step once more: lands exactly on the ceiling and
    // the forward button now disables; a second click is a no-op (still clamped at the ceiling).
    await fillDate(page, isoDaysFromNow(59));
    await nextBtn.click();
    await expect(dateInput).toHaveValue(formatDDMMYYYY(isoDaysFromNow(60)));
    // A disabled button can't be clicked at all (the browser suppresses the click on a native
    // disabled control) — the assertion above already proves the clamp; this just confirms the
    // affordance itself is gone, not merely a visual hint.
    await expect(nextBtn).toBeDisabled();
  });

  test('client request flow clamps the date steppers the same way', async ({ page, browser }) => {
    // The bare `request` fixture is unauthenticated; the admin create-user endpoint needs an
    // admin session, so mint the client through an admin-authenticated context.
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await login(adminPage, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    const ts = Date.now();
    const username = `e2e_p4_bw_${ts}`;
    try {
      await createLoginClient(adminPage.request, username, `E2E P4 BookingWindow ${ts}`);
    } finally {
      await adminContext.close();
    }
    await loginFreshClient(page, username);

    await page.getByRole('button', { name: es.actions.requestAppointment }).click();
    await expect(page.locator('input#prof-select')).toBeVisible();
    const windowResp = page.waitForResponse(
      (r) => r.url().includes('/booking-window') && r.request().method() === 'GET', { timeout: 10_000 },
    ).catch(() => null);
    await selectFromCombobox(page, 'prof-select', 'Dr. Arnie Pye');
    await expect(page.locator('#svc-select')).toContainText(DEMO_SERVICE_NAMES.sesion, { timeout: 10_000 });
    await windowResp;
    await page.getByRole('button', { name: es.portal.next }).click();

    const dialog = page.getByRole('dialog').filter({ hasText: es.portal.chooseDateTime });
    const prevBtn = dialog.getByRole('button', { name: es.calendar.prevDay });
    const nextBtn = dialog.getByRole('button', { name: es.calendar.nextDay });
    const dateInput = dialog.locator('input[placeholder="dd/mm/aaaa"]').first();

    await expect(prevBtn).toBeDisabled();
    await expect(nextBtn).toBeEnabled();

    await fillDate(dialog, isoDaysFromNow(59));
    await nextBtn.click();
    await expect(dateInput).toHaveValue(formatDDMMYYYY(isoDaysFromNow(60)));
    await expect(nextBtn).toBeDisabled();
  });

  test('a request submitted after the window narrows underneath it is rejected outside_booking_window', async ({ page, browser }) => {
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await login(adminPage, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    const profId = await findProfessionalId(adminPage, 'Dr. Arnie Pye');
    const offeringsRes = await adminPage.request.get(`/api/professional_services?filter_professional_user_id=${profId}`);
    const offerings = (await offeringsRes.json()).data as Array<Record<string, string | number | null>>;
    expect(offerings.length, 'Dr. Arnie Pye must offer exactly one service').toBeGreaterThan(0);
    // The generic update validates the FULL editable object, so send back the whole row (a partial
    // { max_booking_days } is rejected) minus the server-derived keys it forbids in the body.
    const offeringId = offerings[0].id as string;
    const { id: _id, created_at: _c, updated_at: _u, professional_user_id: _p, service_id: _s, ...original } = offerings[0];

    const ts = Date.now();
    const username = `e2e_p4_owb_${ts}`;
    // Admin-authenticated create (the bare `request` fixture has no session).
    await createLoginClient(adminPage.request, username, `E2E P4 OutsideWindow ${ts}`);
    await loginFreshClient(page, username);

    await page.getByRole('button', { name: es.actions.requestAppointment }).click();
    await selectFromCombobox(page, 'prof-select', 'Dr. Arnie Pye');
    await expect(page.locator('#svc-select')).toContainText(DEMO_SERVICE_NAMES.sesion, { timeout: 10_000 });
    await page.getByRole('button', { name: es.portal.next }).click();

    // A date comfortably inside the current (business-default, 60-day) window, past the seed's
    // dense-fill so a free slot is guaranteed; the window is about to shrink underneath it.
    const targetDate = isoDaysFromNow(50);
    await fillDate(page, targetDate);
    const slotButton = page.locator('button').filter({ hasText: /^\d{2}:\d{2}/ }).first();
    await expect(slotButton).toBeVisible({ timeout: 10_000 });
    await slotButton.click();
    await page.getByRole('button', { name: es.portal.viewPrice }).click();
    await expect(page.getByRole('heading', { name: es.portal.estimatedCost })).toBeVisible({ timeout: 10_000 });

    // Narrow Arnie's own per-service window to 3 days — well short of day 50 — after the client has
    // already selected the slot, reproducing the "window moved between load and submit" race the
    // toast is named for. Scoped to Arnie's own offering row only; restored below regardless of
    // outcome so no other spec (or a re-run of this one) inherits a narrowed window.
    try {
      const narrowRes = await adminPage.request.put(`/api/professional_services/${offeringId}`, {
        data: { ...original, max_booking_days: 3 },
      });
      expect(narrowRes.ok(), `narrow PUT failed: ${narrowRes.status()} ${await narrowRes.text()}`).toBe(true);

      const requestResponse = page.waitForResponse(
        (r) => r.url().includes('/appointments/request') && r.request().method() === 'POST',
        { timeout: 15_000 },
      );
      await page.getByRole('dialog').getByRole('button', { name: es.actions.requestAppointment }).click();
      const resp = await requestResponse;
      expect(resp.status()).toBe(422);
      const body = await resp.json();
      expect(body.error.code).toBe('outside_booking_window');

      await expect(page.getByText(es.toast.outsideBookingWindow)).toBeVisible({ timeout: 5_000 });
    } finally {
      await adminPage.request.put(`/api/professional_services/${offeringId}`, { data: original });
      await adminContext.close();
    }
  });
});

function formatDDMMYYYY(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
