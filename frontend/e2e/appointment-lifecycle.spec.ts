import { test, expect } from '@playwright/test';
import { login, DEMO_ACCOUNTS, navigateCalendarToAppointment } from './helpers';

/**
 * State transition via the detail panel: approve a requested appointment.
 * The fixture must be created through POST /api/appointments/request, which is
 * restricted to the Client role — so it's created via a Client-authenticated
 * context, while professional/service ids are looked up via an Admin context first
 * (querying /api/professionals as a Client returns an empty list).
 * Professional Dra. Edna Krabappel + client Otto Mann are untouched by any other spec.
 */
test.describe('Appointment state transition via detail panel — approve a requested appointment', () => {
  let apptId: number;

  test.beforeAll(async ({ browser }) => {
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await login(adminPage, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    const profRes = await adminPage.request.get(`/api/professionals?filter_display_name=${encodeURIComponent('Edna Krabappel')}`);
    const prof = (await profRes.json()).data[0];
    const svcRes = await adminPage.request.get(`/api/services?filter_name=${encodeURIComponent('Sesión individual')}`);
    const svc = (await svcRes.json()).data[0];
    await adminContext.close();

    const clientContext = await browser.newContext();
    const clientPage = await clientContext.newPage();
    await login(clientPage, 'demo_client18', 'demo-pass-123'); // Otto Mann

    const reqRes = await clientPage.request.post('/api/appointments/request', {
      data: {
        professional_user_id: Number(prof.id),
        service_id: Number(svc.id),
        date: '2026-07-16',
        start: '09:00',
        duration_minutes: 50,
      },
    });
    const body = await reqRes.json();
    if (!reqRes.ok() || !body.data?.id) {
      throw new Error(`Failed to create 'requested' fixture: ${reqRes.status()} ${JSON.stringify(body)}`);
    }
    apptId = Number(body.data.id);
    expect(body.data.state).toBe('requested');
    await clientContext.close();
  });

  test('admin approves the requested appointment from the detail panel', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('link', { name: 'Calendario' }).click();
    await expect(page.locator('.fc')).toBeVisible();

    await navigateCalendarToAppointment(page, apptId);
    const event = page.locator(`[data-testid="appt-${apptId}"]`).first();
    await expect(event).toHaveAttribute('data-appt-state', 'requested');
    await event.click();

    await expect(page.getByText('Detalle del turno')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Solicitado')).toBeVisible();

    const approveResponse = page.waitForResponse(
      (r) => r.url().includes(`/appointments/${apptId}/approve`) && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await page.getByRole('button', { name: 'Aprobar' }).click();
    const resp = await approveResponse;
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.success).toBe(true);
    expect(body.data.state).toBe('scheduled');

    await expect(page.getByText('Programado')).toBeVisible({ timeout: 10_000 });

    // Independent backend confirmation — proves the transition is durable, not just
    // an optimistic client-side render.
    const checkRes = await page.request.get(`/api/appointments/${apptId}`);
    const checkBody = await checkRes.json();
    expect(checkBody.data.state).toBe('scheduled');
  });
});
