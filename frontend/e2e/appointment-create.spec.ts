import { test, expect } from '@playwright/test';
import { login, DEMO_ACCOUNTS, selectFromCombobox, fillDate, es } from './helpers';
import { DEMO_SERVICE_NAMES, shiftSeedDate } from '../../shared/src/dev-fixtures';

/**
 * Regression coverage for: "selecting a resource blanks the client/professional
 * pickers". Uses a client/professional/resource combination not touched by any
 * other spec (Troy McClure, Dr. Ned Flanders, Consultorio 3) and a date with no
 * seeded appointments for that professional, so the fixture is fully self-contained.
 */
test.describe('Appointment creation — full form with client + professional + resource', () => {
  test('selections survive picking a resource, and the appointment is created with all fields', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    const [clientRes, profRes, svcRes, resourceRes] = await Promise.all([
      page.request.get(`/api/clients?filter_display_name=${encodeURIComponent('Troy McClure')}`),
      page.request.get(`/api/professionals?filter_display_name=${encodeURIComponent('Ned Flanders')}`),
      page.request.get(`/api/services?filter_name=${encodeURIComponent(DEMO_SERVICE_NAMES.sesion)}`),
      page.request.get(`/api/resources?filter_name=${encodeURIComponent('Consultorio 3')}`),
    ]);
    const client = (await clientRes.json()).data[0];
    const prof = (await profRes.json()).data[0];
    const svc = (await svcRes.json()).data[0];
    const resource = (await resourceRes.json()).data[0];
    expect(client, 'Troy McClure must exist in the seed').toBeTruthy();
    expect(prof, 'Dr. Ned Flanders must exist in the seed').toBeTruthy();
    expect(svc, 'Sesión de Psicología Infantil must exist in the seed').toBeTruthy();
    expect(resource, 'Consultorio 3 must exist in the seed').toBeTruthy();

    await page.getByRole('link', { name: es.nav.calendar }).click();
    await expect(page.locator('.fc')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: es.calendar.newAppointment }).click();

    // Client and professional are searchable Selector comboboxes now (headlessui Combobox:
    // input#<id> + [role=option] list), not native <select>s.
    const clientInput = page.locator('input#appt-client');
    const profInput = page.locator('input#appt-prof');
    const serviceField = page.locator('#appt-service');
    const resourceSelect = page.locator('#appt-resource');

    await selectFromCombobox(page, 'appt-client', 'Troy McClure');
    await selectFromCombobox(page, 'appt-prof', 'Dr. Ned Flanders');

    // Dr. Ned Flanders offers a single service, so the service Selector collapses to a read-only
    // label and auto-selects it — no interaction needed.
    await expect(serviceField).toContainText(DEMO_SERVICE_NAMES.sesion, { timeout: 10_000 });

    // The combobox input displays the selected label, not the id.
    await expect(clientInput).toHaveValue(/Troy McClure/);
    await expect(profInput).toHaveValue(/Ned Flanders/);

    // THE regression guard: selecting a resource must NOT blank client/professional.
    await expect(resourceSelect.locator('option', { hasText: 'Consultorio 3' })).toBeAttached({ timeout: 10_000 });
    await resourceSelect.selectOption({ label: 'Consultorio 3' });

    await expect(clientInput).toHaveValue(/Troy McClure/);
    await expect(profInput).toHaveValue(/Ned Flanders/);
    await expect(resourceSelect).toHaveValue(String(resource.id));

    const slotButton = page.locator('button').filter({ hasText: /^\d{2}:\d{2}/ }).first();

    // Wait for the actual /api/availability round-trip (not a blind timeout) before
    // checking for a rendered slot — avoids a race on a cold-started dev server.
    async function fillDateAndWaitForAvailability(date: string): Promise<void> {
      const availResponse = page.waitForResponse(
        (r) => r.url().includes('/api/availability') && r.request().method() === 'GET',
        { timeout: 15_000 },
      ).catch(() => null);
      await fillDate(page, date);
      await availResponse;
    }

    // Future, in-window (≤60 days) dates past the dense-seed window (~45 days from 2026-07-06) so
    // free slots are guaranteed; the create-mode date picker rejects past dates (min = today).
    let targetDate = shiftSeedDate('2026-08-25');
    await fillDateAndWaitForAvailability(targetDate);
    let slotVisible = await slotButton.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!slotVisible) {
      targetDate = shiftSeedDate('2026-08-26');
      await fillDateAndWaitForAvailability(targetDate);
      slotVisible = await slotButton.isVisible({ timeout: 5_000 }).catch(() => false);
    }
    expect(slotVisible, 'Expected a free slot for Dr. Ned Flanders').toBe(true);
    await slotButton.click();

    // Selections must STILL hold after picking a slot.
    await expect(clientInput).toHaveValue(/Troy McClure/);
    await expect(profInput).toHaveValue(/Ned Flanders/);
    await expect(resourceSelect).toHaveValue(String(resource.id));

    const scheduleResponse = page.waitForResponse(
      (r) => r.url().includes('/appointments/schedule') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await page.getByRole('button', { name: es.actions.save }).click();
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
    await expect(page.getByText(es.calendar.detailTitle)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(`${svc.default_duration_minutes} min`)).toBeVisible({ timeout: 10_000 });
  });
});
