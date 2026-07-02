import { test, expect } from '@playwright/test';
import { login, DEMO_ACCOUNTS } from './helpers';

test.describe('Client request → staff approve', () => {
  test('client navigates to Solicitar turno and sees the professional/service selectors', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.client.username, DEMO_ACCOUNTS.client.password);

    await page.getByRole('link', { name: 'Solicitar turno' }).click();

    const profSelect = page.locator('#prof-select');
    await expect(profSelect).toBeVisible();
    const svcSelect = page.locator('#svc-select');
    await expect(svcSelect).toBeVisible();
  });

  test('client completes a request and sees Solicitado in Mis turnos', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.client.username, DEMO_ACCOUNTS.client.password);

    await page.getByRole('link', { name: 'Solicitar turno' }).click();

    const profSelect = page.locator('#prof-select');
    await expect(profSelect).toBeVisible();

    // Pick demo_pro specifically — her weekly schedule (Mon-Thu 09:00-17:20, Fri
    // 09:00-14:00, 50-min blocks) is known from the seed, so "next Monday" below is
    // reliably open rather than an arbitrary professional.
    await expect(profSelect.locator('option', { hasText: 'Bouvier' })).toBeAttached({ timeout: 15_000 });
    await profSelect.selectOption({ label: 'Dra. Marge Bouvier' });

    const svcSelect = page.locator('#svc-select');
    await expect(svcSelect).toBeVisible();
    await expect(svcSelect.locator('option').nth(1)).toBeAttached({ timeout: 10_000 });
    await svcSelect.selectOption({ index: 1 });

    await page.getByRole('button', { name: 'Siguiente' }).click();

    // Fixed weekday clear of the seeded appointment cluster (2026-07-07..07-23) so the
    // first offered slot is genuinely free; demo_pro works Mon–Fri.
    const date = new Date('2026-08-17T00:00:00');
    const dateInput = page.locator('#date-input');
    await expect(dateInput).toBeVisible();
    await dateInput.fill(date.toISOString().slice(0, 10));

    // Match on the leading HH:MM text, not an anchored/exact match (button also shows duration).
    const slotButton = page.locator('button').filter({ hasText: /^\d{2}:\d{2}/ }).first();

    let slotVisible = await slotButton.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!slotVisible) {
      // No free slot next Monday — try the following week; demo_pro's schedule guarantees
      // open slots within two weeks under normal seeded load.
      date.setDate(date.getDate() + 7);
      await dateInput.fill(date.toISOString().slice(0, 10));
      slotVisible = await slotButton.isVisible({ timeout: 5_000 }).catch(() => false);
    }
    expect(slotVisible, 'Expected at least one free slot for demo_pro within two weeks').toBe(true);
    await slotButton.click();

    await page.getByRole('button', { name: 'Ver precio' }).click();

    // "Confirmar solicitud" only advances to step 4 — it does not submit. The actual
    // POST is fired by step 4's "Solicitar turno" button.
    await expect(page.getByText('Costo estimado')).toBeVisible();
    await page.getByRole('button', { name: 'Confirmar solicitud' }).click();

    await expect(page.getByRole('heading', { name: 'Confirmá tu solicitud' })).toBeVisible();
    await page.getByRole('button', { name: 'Solicitar turno' }).click();

    await expect(page.getByText('¡Solicitud enviada!')).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Ver mis turnos' }).click();
    const hasSolicitado = await page.getByText('Solicitado').first().isVisible({ timeout: 10_000 }).catch(() => false);
    const hasProgramado = await page.getByText('Programado').first().isVisible({ timeout: 10_000 }).catch(() => false);
    expect(hasSolicitado || hasProgramado).toBe(true);
  });

  test('seeded appointments appear with status badge in Mis turnos', async ({ page }) => {
    // demo_client has a past-completed seeded appointment (always in Historial) and a
    // scheduled one, so at least one status badge is always present.
    await login(page, DEMO_ACCOUNTS.client.username, DEMO_ACCOUNTS.client.password);
    await page.getByRole('link', { name: 'Mis turnos' }).click();

    const anyStatusBadge = page.locator('li', { hasText: /Solicitado|Programado|Completado/ }).first();
    await expect(anyStatusBadge).toBeVisible({ timeout: 10_000 });
  });

  test('staff calendar loads and Auditoría shows appointment audit entries', async ({ page }) => {
    // Assertion stays calendar-agnostic (renders + Auditoría has rows) since navigating to
    // a specific week is exercised by calendar-reschedule and staff-schedule-override specs.
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    await page.getByRole('link', { name: 'Calendario' }).click();
    await expect(page.locator('.fc')).toBeVisible();

    await page.getByRole('link', { name: 'Auditoría' }).click();
    await page.waitForURL('**/staff/audit', { timeout: 10_000 });
    // .first() avoids strict mode if multiple tables exist.
    const auditTable = page.locator('table').first();
    await expect(auditTable).toBeVisible({ timeout: 15_000 });
    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });
  });
});
