import { test, expect } from '@playwright/test';
import { login, DEMO_ACCOUNTS, navigateCalendarToAppointment, es, stateLabelEs } from './helpers';
import { DEMO_SERVICE_NAMES, shiftSeedDate } from '../../shared/src/dev-fixtures';

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
    const svcRes = await adminPage.request.get(`/api/services?filter_name=${encodeURIComponent(DEMO_SERVICE_NAMES.sesion)}`);
    const svc = (await svcRes.json()).data[0];
    await adminContext.close();

    const clientContext = await browser.newContext();
    const clientPage = await clientContext.newPage();
    await login(clientPage, 'demo_client18', 'demo-pass-123'); // Otto Mann

    const reqRes = await clientPage.request.post('/api/appointments/request', {
      data: {
        professional_user_id: Number(prof.id),
        service_id: Number(svc.id),
        // Dra. Edna Krabappel's Tue "sesión" block starts 09:00 (50-min slots). shiftSeedDate keeps
        // this authored Tuesday aligned with the seed's shift, landing past the dense-fill window yet
        // within the 60-day booking window, so the slot is conflict-free. /request cannot override,
        // so the fixture must land on a genuinely free, slot-aligned start.
        date: shiftSeedDate('2026-08-25'),
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
    await page.getByRole('link', { name: es.nav.calendar }).click();
    await expect(page.locator('.fc')).toBeVisible();

    await navigateCalendarToAppointment(page, apptId);
    const event = page.locator(`[data-testid="appt-${apptId}"]`).first();
    await expect(event).toHaveAttribute('data-appt-state', 'requested');
    await event.click();

    await expect(page.getByText(es.calendar.detailTitle)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(stateLabelEs('requested'))).toBeVisible();

    const approveResponse = page.waitForResponse(
      (r) => r.url().includes(`/appointments/${apptId}/approve`) && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await page.getByRole('button', { name: es.calendar.approve }).click();
    const resp = await approveResponse;
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.success).toBe(true);
    expect(body.data.state).toBe('scheduled');

    await expect(page.getByText(stateLabelEs('scheduled'))).toBeVisible({ timeout: 10_000 });

    // Independent backend confirmation — proves the transition is durable, not just
    // an optimistic client-side render.
    const checkRes = await page.request.get(`/api/appointments/${apptId}`);
    const checkBody = await checkRes.json();
    expect(checkBody.data.state).toBe('scheduled');
  });
});
