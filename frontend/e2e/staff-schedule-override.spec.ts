import { test, expect } from '@playwright/test';
import { login, DEMO_ACCOUNTS } from './helpers';

/**
 * The seed plants TWO appointments for the SAME professional (demo_pro) at the SAME
 * fixed instant — 2026-07-07T10:00 America/Argentina/Buenos_Aires. Targeting that exact
 * professional + date + time guarantees a real double-booking regardless of what "today"
 * is when this spec runs.
 */
test.describe('Staff schedule — conflict override (sobreturno)', () => {
  test('appointment form shows conflict override dialog on scheduling overlap', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    await page.getByRole('link', { name: 'Calendario' }).click();

    await page.getByRole('button', { name: 'Nuevo turno' }).click();

    const profSelect = page.locator('#appt-prof');
    await expect(profSelect).toBeVisible();

    await expect(profSelect.locator('option', { hasText: 'Bouvier' })).toBeAttached({ timeout: 10_000 });
    await profSelect.selectOption({ label: 'Dra. Marge Bouvier' });

    const serviceSelect = page.locator('#appt-service');
    await expect(serviceSelect.locator('option').nth(1)).toBeAttached({ timeout: 10_000 });
    await serviceSelect.selectOption({ index: 1 });

    // Fixed date/time deliberately colliding with the seeded appointments.
    const dateInput = page.locator('#appt-date');
    await dateInput.fill('2026-07-07');

    const startInput = page.locator('#appt-start');
    await startInput.fill('10:00');
    const durInput = page.locator('#appt-duration');
    await durInput.fill('50');

    await expect(page.locator('#appt-prof')).toBeVisible();

    // Wait for the schedule POST to complete so we don't poll for the dialog before the
    // backend round-trip finishes.
    const scheduleResponse = page.waitForResponse(
      (r) => r.url().includes('/appointments/schedule') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await page.getByRole('button', { name: 'Guardar' }).click();
    await scheduleResponse.catch(() => null);

    const overrideButton = page.locator('button', { hasText: 'Reservar de todos modos' });
    await expect(overrideButton).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Este horario se superpone con un turno existente')).toBeVisible();

    await overrideButton.click();
    await expect(overrideButton).not.toBeVisible({ timeout: 10_000 });
  });

  test('Auditoría screen shows a conflict_override (sobreturno) audit event from seeded data', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('link', { name: 'Auditoría' }).click();

    // The audit_events table is seeded with at least one conflict_override entry, plus the
    // one this spec's first test just created. The event-type filter is a free-text input.
    await expect(page.locator('table')).toBeVisible({ timeout: 15_000 });

    await page.getByPlaceholder('Tipo de evento').fill('conflict_override');
    await page.getByRole('button', { name: 'Buscar' }).click();

    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });
    await expect(rows.first()).toContainText('conflict_override');
  });
});
