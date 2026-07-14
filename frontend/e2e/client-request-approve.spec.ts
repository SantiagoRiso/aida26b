import { test, expect } from '@playwright/test';
import { login, DEMO_ACCOUNTS, selectFromCombobox, fillDate, es, stateLabelEs } from './helpers';
import { DEMO_SERVICE_NAMES, shiftSeedDate } from '../../shared/src/dev-fixtures';

test.describe('Client request → staff approve', () => {
  test('client opens Solicitar turno and sees the professional/service selectors', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.client.username, DEMO_ACCOUNTS.client.password);

    // The request flow is a modal launched from a button on "Mis turnos", not a nav link.
    await page.getByRole('button', { name: es.actions.requestAppointment }).click();

    // #prof-select is a searchable Selector combobox (input); #svc-select is a native <select>
    // until a professional with a single offering collapses it to a read-only label.
    await expect(page.locator('input#prof-select')).toBeVisible();
    await expect(page.locator('#svc-select')).toBeVisible();
  });

  test('client completes a request and sees Solicitado in Mis turnos', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.client.username, DEMO_ACCOUNTS.client.password);

    await page.getByRole('button', { name: es.actions.requestAppointment }).click();

    // Pick demo_pro (Dra. Marge Bouvier) via the searchable combobox — her weekly schedule
    // (Mon-Thu split mornings/afternoons, Fri 09:00-14:00, 50-min blocks) is known from the seed,
    // so a date past the dense-seed window reliably has open slots.
    await expect(page.locator('input#prof-select')).toBeVisible();
    await selectFromCombobox(page, 'prof-select', 'Dra. Marge Bouvier');

    // She offers a single service, so #svc-select collapses to a read-only label and auto-selects it.
    await expect(page.locator('#svc-select')).toContainText(DEMO_SERVICE_NAMES.sesion, { timeout: 15_000 });

    await page.getByRole('button', { name: es.portal.next }).click();

    // A Monday past the dense-seed window (seed fills ~45 days from 2026-07-06, i.e. through
    // ~2026-08-19) so the first offered slot is genuinely free; demo_pro works Mon–Fri.
    let date = shiftSeedDate('2026-08-24');
    await expect(page.locator('input[placeholder="dd/mm/aaaa"]')).toBeVisible();
    await fillDate(page, date);

    // Match on the leading HH:MM text, not an anchored/exact match (button also shows duration).
    const slotButton = page.locator('button').filter({ hasText: /^\d{2}:\d{2}/ }).first();

    let slotVisible = await slotButton.isVisible({ timeout: 8_000 }).catch(() => false);
    // Fall through successive Mondays (all past the dense-seed window, within the 60-day booking
    // window) until one has a free slot; wait on the availability round-trip each time rather than a
    // blind timeout.
    for (const nextDate of [shiftSeedDate('2026-08-31')]) {
      if (slotVisible) break;
      const avail = page
        .waitForResponse((r) => r.url().includes('/api/availability') && r.request().method() === 'GET', { timeout: 10_000 })
        .catch(() => null);
      await fillDate(page, nextDate);
      await avail;
      slotVisible = await slotButton.isVisible({ timeout: 8_000 }).catch(() => false);
    }
    expect(slotVisible, 'Expected at least one free slot for demo_pro').toBe(true);
    await slotButton.click();

    await page.getByRole('button', { name: es.portal.viewPrice }).click();

    // Step 3 shows the estimated cost, then submits directly (no separate confirm step).
    await expect(page.getByRole('heading', { name: es.portal.estimatedCost })).toBeVisible();

    // Scope the submit to the dialog: the "Mis turnos" page behind the modal also carries a
    // "Solicitar turno" button.
    const requestResponse = page.waitForResponse(
      (r) => r.url().includes('/appointments/request') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await page.getByRole('dialog').getByRole('button', { name: es.actions.requestAppointment }).click();
    const resp = await requestResponse;
    expect(resp.status()).toBe(201);

    // On success the modal closes and Mis turnos reloads; the new request shows a 'Solicitado' badge.
    await expect(page.getByText(stateLabelEs('requested')).first()).toBeVisible({ timeout: 10_000 });
  });

  test('seeded appointments appear with status badge in Mis turnos', async ({ page }) => {
    // demo_client has a past-completed seeded appointment (always in Historial) and a
    // scheduled one, so at least one status badge is always present.
    await login(page, DEMO_ACCOUNTS.client.username, DEMO_ACCOUNTS.client.password);
    await page.getByRole('link', { name: es.nav.myAppointments }).click();

    const anyStatusBadge = page.locator('li', { hasText: /Solicitado|Programado|Completado/ }).first();
    await expect(anyStatusBadge).toBeVisible({ timeout: 10_000 });
  });

  test('staff calendar loads and Auditoría shows appointment audit entries', async ({ page }) => {
    // Assertion stays calendar-agnostic (renders + Auditoría has rows) since navigating to
    // a specific week is exercised by calendar-reschedule and staff-schedule-override specs.
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    await page.getByRole('link', { name: es.nav.calendar }).click();
    await expect(page.locator('.fc')).toBeVisible();

    await page.getByRole('link', { name: es.nav.audit }).click();
    await page.waitForURL('**/staff/audit', { timeout: 10_000 });
    // .first() avoids strict mode if multiple tables exist.
    const auditTable = page.locator('table').first();
    await expect(auditTable).toBeVisible({ timeout: 15_000 });
    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });
  });
});
