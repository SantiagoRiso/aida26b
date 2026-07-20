import { test, expect } from '@playwright/test';
import {
  login, DEMO_ACCOUNTS, selectFromCombobox, fillDate, fillTime,
  scheduleViaApi, findProfessionalId, findServiceId, findClientId, es,
} from './helpers';
import { DEMO_SERVICE_NAMES, shiftSeedDate } from '../../shared/src/dev-fixtures';

/**
 * The seed plants TWO appointments for the SAME professional (demo_pro) at the SAME
 * fixed instant — 2026-07-07T10:00 America/Argentina/Buenos_Aires. Targeting that exact
 * professional + date + time guarantees a real double-booking regardless of what "today"
 * is when this spec runs.
 */
test.describe('Staff schedule — conflict override (sobreturno)', () => {
  test('appointment form shows conflict override dialog on scheduling overlap', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    // Seed a conflicting turno at a future, in-window slot (the create-mode date picker rejects
    // past dates, so the collision must be in the future). 2026-08-25 is a Tuesday inside Marge's
    // morning block and past the dense-seed window, so 10:00 is otherwise free.
    const CONFLICT_DATE = shiftSeedDate('2026-08-25');
    const profId = await findProfessionalId(page, 'Dra. Marge Bouvier');
    const svcId = await findServiceId(page, DEMO_SERVICE_NAMES.sesion);
    const clientId = await findClientId(page, 'Ruth Powers');
    await scheduleViaApi(page, {
      professional_user_id: profId, service_id: svcId, client_user_id: clientId,
      date: CONFLICT_DATE, start: '10:00', duration_minutes: 50, name: 'Conflicto sembrado E2E',
    });

    await page.getByRole('link', { name: es.nav.calendar }).click();

    await page.getByRole('button', { name: es.calendar.newAppointment }).click();

    // Professional is a searchable Selector combobox now (headlessui Combobox), not a native <select>.
    const profInput = page.locator('input#appt-prof');
    await expect(profInput).toBeVisible();
    await selectFromCombobox(page, 'appt-prof', 'Dra. Marge Bouvier');

    // Dra. Marge Bouvier offers a single service, so the service Selector collapses to a read-only
    // label and auto-selects it — no interaction needed.
    await expect(page.locator('#appt-service')).toContainText(DEMO_SERVICE_NAMES.sesion, { timeout: 10_000 });

    // A fresh "Nuevo turno" opens in slot-picker mode; check "Sobreturno" to enter the manual
    // hora/duración needed to book the exact off-slot instant that collides with the seed.
    await page.getByRole('checkbox', { name: es.calendar.fineMode }).check();

    // Book the same slot as the seeded turno above → the schedule check returns a conflict verdict.
    await fillDate(page, CONFLICT_DATE);

    await fillTime(page, 'appt-start', '10:00');
    const durInput = page.locator('#appt-duration');
    await durInput.fill('50');

    await expect(profInput).toBeVisible();

    // Wait for the schedule POST to complete so we don't poll for the dialog before the
    // backend round-trip finishes.
    const scheduleResponse = page.waitForResponse(
      (r) => r.url().includes('/appointments/schedule') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await page.getByRole('button', { name: es.actions.save }).click();
    await scheduleResponse.catch(() => null);

    const overrideButton = page.locator('button', { hasText: es.actions.bookAnyway });
    await expect(overrideButton).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Este horario se superpone con un turno existente')).toBeVisible();

    await overrideButton.click();
    await expect(overrideButton).not.toBeVisible({ timeout: 10_000 });
  });

  test('Auditoría screen shows the conflict_override event for the sobreturno just forced', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    // Wait for the mount-time audit load to resolve, else the table assertion races the fetch.
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/audit') && r.request().method() === 'GET'),
      page.getByRole('link', { name: es.nav.audit }).click(),
    ]);

    // Every forced save emits conflict_override alongside its lifecycle event, so the newest row
    // here is the sobreturno the previous test forced through the UI — not the seeded example.
    // The list is ordered by created_at DESC and the event-type filter matches exactly.
    await expect(page.locator('table')).toBeVisible({ timeout: 15_000 });

    await page.getByPlaceholder(es.audit.eventTypePlaceholder).fill('conflict_override');
    await page.getByRole('button', { name: es.audit.search }).click();

    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });
    await expect(rows.first()).toContainText('conflict_override');
    // Two entries: the seeded example plus the one just forced. Proves the live path audits.
    await expect(rows).toHaveCount(2);
  });
});
