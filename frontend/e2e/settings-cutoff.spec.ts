import { test, expect } from '@playwright/test';
import { login, DEMO_ACCOUNTS, es } from './helpers';

/**
 * A re-rendered #biz-cutoff field only proves the client-side value round-trips through
 * BusinessView.vue's own onMounted fetch, not that it was actually persisted server-side. This
 * proves persistence through the actual enforced behavior instead: a fresh appointment ~30h out
 * is inside the NEW 48h cutoff but would have been outside the OLD 24h default, so a client
 * cancel attempt must now be blocked. The business-wide cutoff is restored to the seeded default
 * (24) in afterAll so later specs (e.g. client-cancel-cutoff.spec.ts, if re-run) see the value
 * they assume.
 */
test.describe('Business settings — cancellation cutoff persists and is enforced', () => {
  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const loginRes = await page.request.post('/api/auth/login', {
      data: { username: DEMO_ACCOUNTS.adminUser.username, password: DEMO_ACCOUNTS.adminUser.password },
    });
    const businessId = (await loginRes.json()).data.user.business_id;
    await page.request.patch(`/api/businesses/${businessId}/settings`, { data: { cancellation_cutoff_hours: 24 } });
    await context.close();
  });

  test('admin updates the cutoff to 48h and it is enforced on a fresh appointment', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('link', { name: es.nav.business }).click();

    // #biz-cutoff — the cancellation-cutoff field on BusinessView; the section now also has
    // min/max booking-day number inputs, so a bare input[type="number"] selector is ambiguous.
    const cutoffInput = page.locator('#biz-cutoff');
    await expect(cutoffInput).toBeVisible({ timeout: 10_000 });
    await cutoffInput.fill('48');

    const saveResponse = page.waitForResponse(
      (r) => /\/businesses\/\d+\/settings$/.test(r.url()) && r.request().method() === 'PATCH',
      { timeout: 10_000 },
    );
    await page.getByRole('button', { name: es.actions.save }).click();
    const resp = await saveResponse;
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(Number(body.data.cancellation_cutoff_hours)).toBe(48);
    await expect(page.getByText(es.toast.settingsSaved)).toBeVisible({ timeout: 5_000 });

    const [profRes, svcRes, clientRes] = await Promise.all([
      page.request.get(`/api/professionals?filter_display_name=${encodeURIComponent('Dra. Marge Bouvier')}`),
      page.request.get(`/api/services?filter_name=${encodeURIComponent('Sesión de Psicología Infantil')}`),
      page.request.get(`/api/clients?filter_display_name=${encodeURIComponent('Homero Simpson')}`),
    ]);
    const prof = (await profRes.json()).data[0];
    const svc = (await svcRes.json()).data[0];
    const client = (await clientRes.json()).data[0];

    // The turno has to sit inside the 48h cutoff for the cancel to be refused, but the hour must not
    // be inherited from the clock: a run started in the early evening put the start near 23:00, and
    // the service duration then spilled past midnight, which the server rejects outright. Booking
    // midday on the day 30h out keeps it 18 to 42h away, inside the cutoff at any hour of the day.
    const startAt = new Date(Date.now() + 30 * 60 * 60 * 1000);
    const date = `${startAt.getFullYear()}-${String(startAt.getMonth() + 1).padStart(2, '0')}-${String(startAt.getDate()).padStart(2, '0')}`;
    const start = '12:00';

    const scheduleRes = await page.request.post('/api/appointments/schedule', {
      data: {
        professional_user_id: Number(prof.id),
        service_id: Number(svc.id),
        client_user_id: Number(client.id),
        date, start,
        duration_minutes: Number(svc.default_duration_minutes),
        name: 'Turno E2E cutoff-persistence',
        override: true, // bypasses any incidental conflict — this test targets the cutoff gate only
      },
    });
    const scheduleBody = await scheduleRes.json();
    expect(scheduleRes.ok(), `Failed to create fixture appointment: ${JSON.stringify(scheduleBody)}`).toBe(true);
    const apptId = Number(scheduleBody.data.id);

    const clientContext = await page.context().browser()!.newContext();
    const clientPage = await clientContext.newPage();
    await login(clientPage, DEMO_ACCOUNTS.client.username, DEMO_ACCOUNTS.client.password);

    // With the OLD 24h default this would succeed (30h > 24h); with the NEW 48h cutoff
    // just saved, it must now be blocked — proving the setting persisted server-side.
    const cancelRes = await clientPage.request.post(`/api/appointments/${apptId}/transition`, {
      data: { to: 'canceled' },
    });
    expect(cancelRes.status()).toBe(422);
    const cancelBody = await cancelRes.json();
    expect(cancelBody.error.code).toBe('outside_cutoff');
    await clientContext.close();
  });
});
