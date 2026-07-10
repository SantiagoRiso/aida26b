import { test, expect } from '@playwright/test';
import { login, DEMO_ACCOUNTS } from './helpers';

/**
 * Regression coverage for: "selecting a resource blanks the client/professional
 * dropdowns". Uses a client/professional/resource combination not touched by any
 * other spec (Troy McClure, Dr. Ned Flanders, Consultorio 3) and a date with no
 * seeded appointments for that professional, so the fixture is fully self-contained.
 */
test.describe('Appointment creation — full form with client + professional + resource', () => {
  test('selections survive picking a resource, and the appointment is created with all fields', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    const [clientRes, profRes, svcRes, resourceRes] = await Promise.all([
      page.request.get(`/api/clients?filter_display_name=${encodeURIComponent('Troy McClure')}`),
      page.request.get(`/api/professionals?filter_display_name=${encodeURIComponent('Ned Flanders')}`),
      page.request.get(`/api/services?filter_name=${encodeURIComponent('Sesión individual')}`),
      page.request.get(`/api/resources?filter_name=${encodeURIComponent('Consultorio 3')}`),
    ]);
    const client = (await clientRes.json()).data[0];
    const prof = (await profRes.json()).data[0];
    const svc = (await svcRes.json()).data[0];
    const resource = (await resourceRes.json()).data[0];
    expect(client, 'Troy McClure must exist in the seed').toBeTruthy();
    expect(prof, 'Dr. Ned Flanders must exist in the seed').toBeTruthy();
    expect(svc, 'Sesión individual must exist in the seed').toBeTruthy();
    expect(resource, 'Consultorio 3 must exist in the seed').toBeTruthy();

    await page.getByRole('link', { name: 'Calendario' }).click();
    await expect(page.locator('.fc')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Nuevo turno' }).click();

    const clientSelect = page.locator('#appt-client');
    const profSelect = page.locator('#appt-prof');
    const serviceSelect = page.locator('#appt-service');
    const resourceSelect = page.locator('#appt-resource');

    await expect(clientSelect.locator('option', { hasText: 'Troy McClure' })).toBeAttached({ timeout: 10_000 });
    await clientSelect.selectOption({ label: 'Troy McClure' });

    await expect(profSelect.locator('option', { hasText: 'Flanders' })).toBeAttached({ timeout: 10_000 });
    await profSelect.selectOption({ label: 'Dr. Ned Flanders' });

    await expect(serviceSelect.locator('option', { hasText: 'Sesión individual' })).toBeAttached({ timeout: 10_000 });
    await serviceSelect.selectOption({ label: 'Sesión individual' });

    await expect(clientSelect).toHaveValue(String(client.id));
    await expect(profSelect).toHaveValue(String(prof.id));

    // THE regression guard: selecting a resource must NOT blank client/professional.
    await expect(resourceSelect.locator('option', { hasText: 'Consultorio 3' })).toBeAttached({ timeout: 10_000 });
    await resourceSelect.selectOption({ label: 'Consultorio 3' });

    await expect(clientSelect).toHaveValue(String(client.id));
    await expect(profSelect).toHaveValue(String(prof.id));
    await expect(resourceSelect).toHaveValue(String(resource.id));

    const dateInput = page.locator('#appt-date');
    const slotButton = page.locator('button').filter({ hasText: /^\d{2}:\d{2}/ }).first();

    // Wait for the actual /api/availability round-trip (not a blind timeout) before
    // checking for a rendered slot — avoids a race on a cold-started dev server.
    async function fillDateAndWaitForAvailability(date: string): Promise<void> {
      const availResponse = page.waitForResponse(
        (r) => r.url().includes('/api/availability') && r.request().method() === 'GET',
        { timeout: 15_000 },
      ).catch(() => null);
      await dateInput.fill(date);
      await availResponse;
    }

    let targetDate = '2026-07-16';
    await fillDateAndWaitForAvailability(targetDate);
    let slotVisible = await slotButton.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!slotVisible) {
      targetDate = '2026-07-15';
      await fillDateAndWaitForAvailability(targetDate);
      slotVisible = await slotButton.isVisible({ timeout: 5_000 }).catch(() => false);
    }
    expect(slotVisible, 'Expected a free slot for Dr. Ned Flanders on 2026-07-15/16').toBe(true);
    await slotButton.click();

    // Selections must STILL hold after picking a slot.
    await expect(clientSelect).toHaveValue(String(client.id));
    await expect(profSelect).toHaveValue(String(prof.id));
    await expect(resourceSelect).toHaveValue(String(resource.id));

    const scheduleResponse = page.waitForResponse(
      (r) => r.url().includes('/appointments/schedule') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await page.getByRole('button', { name: 'Guardar' }).click();
    const resp = await scheduleResponse;
    expect(resp.status()).toBe(201);
    const body = await resp.json();
    expect(body.success).toBe(true);
    expect(Number(body.data.client_user_id)).toBe(Number(client.id));
    expect(Number(body.data.professional_user_id)).toBe(Number(prof.id));
    expect(Number(body.data.resource_id)).toBe(Number(resource.id));
    expect(Number(body.data.service_id)).toBe(Number(svc.id));
    expect(body.data.state).toBe('scheduled');

    // The saved appointment opens its detail panel — confirms the "was created" outcome
    // is also reflected in the UI, not just the API response. (The calendar's visible
    // week is still "today"'s — the fixture date is intentionally weeks ahead — so the
    // detail panel, not the grid, is the right UI signal here.)
    await expect(page.getByText('Detalle del turno')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(`${svc.default_duration_minutes} min`)).toBeVisible({ timeout: 10_000 });
  });
});
