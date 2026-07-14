import { test, expect } from '@playwright/test';
import { login, DEMO_ACCOUNTS, navigateCalendarToAppointment, fillTime, es } from './helpers';
import { shiftSeedDate } from '../../shared/src/dev-fixtures';

/**
 * The seed plants several appointments for the SAME professional (demo_pro) in the
 * week of 2026-07-07 — Homero at 10:00 and Bart at 11:00, both fixed calendar dates.
 * Dragging Bart's event onto Homero's slot reliably reproduces a real double-booking
 * for the same professional, independent of whatever "today" is when this spec runs
 * (as long as it runs before 2026-07-07).
 */
test.describe('Calendar drag-reschedule — conflict flow', () => {
  // Bounded to a handful of clicks — the demo seed fills scheduled appointments across several
  // weeks from the "current" week, so the default landing week usually already holds some.
  async function navigateToSeededWeek(page: import('@playwright/test').Page) {
    await page.getByRole('link', { name: es.nav.calendar }).click();
    await expect(page.locator('.fc')).toBeVisible();

    for (let i = 0; i < 6; i++) {
      if (await page.locator('[data-appt-state="scheduled"]').first().isVisible().catch(() => false)) return;
      const nextFetch = page.waitForResponse(
        (r) => r.url().includes('/appointments') && r.request().method() === 'GET',
        { timeout: 10_000 },
      ).catch(() => null);
      await page.locator('.fc-next-button').click();
      await nextFetch;
    }
  }

  test('calendar renders the seeded scheduled appointments with data-appt-state', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await navigateToSeededWeek(page);

    await expect(page.locator('[data-appt-state="scheduled"]').first())
      .toBeVisible({ timeout: 10_000 });
  });

  /**
   * Playwright drag on FullCalendar (dragTo) is unreliable in this environment — both
   * former drag-based tests here timed out repeatedly on "element intercepts pointer
   * events" against neighboring event blocks. Replaced with the detail-panel + form
   * reschedule flow (AppointmentDetailPanel "Reprogramar" → AppointmentForm), which is
   * deterministic and exercises the same backend reschedule/conflict endpoints. Each
   * test creates its own fixtures (professional Dr. Julius Hibbert, clients Hans Moleman
   * and Professor Frink — untouched by any other spec) so it doesn't depend on the
   * shared seeded scheduled appointments used by the rendering test above.
   */
  test.describe('reschedule via detail panel + form (no drag)', () => {
    let apptAId: number;
    let apptBId: number;

    test.beforeAll(async ({ browser }) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

      const [profRes, svcRes, clientARes, clientBRes] = await Promise.all([
        page.request.get(`/api/professionals?filter_display_name=${encodeURIComponent('Julius Hibbert')}`),
        page.request.get(`/api/services?filter_name=${encodeURIComponent('Consulta médica')}`),
        page.request.get(`/api/clients?filter_display_name=${encodeURIComponent('Hans Moleman')}`),
        page.request.get(`/api/clients?filter_display_name=${encodeURIComponent('Professor Frink')}`),
      ]);
      const prof = (await profRes.json()).data[0];
      const svc = (await svcRes.json()).data[0];
      const clientA = (await clientARes.json()).data[0];
      const clientB = (await clientBRes.json()).data[0];

      async function schedule(clientId: number, start: string, name: string): Promise<number> {
        // 2026-08-27 (Thursday) is past the seed's ~45-day dense-fill window, so Dr. Hibbert's
        // 08:00/09:00/10:00 medico slots are free — the reschedule-to-a-free-slot test needs an
        // empty 10:00. override:true still guards fixture creation against any stray occupancy.
        const res = await page.request.post('/api/appointments/schedule', {
          data: {
            override: true,
            professional_user_id: Number(prof.id),
            service_id: Number(svc.id),
            client_user_id: clientId,
            date: shiftSeedDate('2026-08-27'),
            start,
            duration_minutes: 30,
            name,
          },
        });
        const body = await res.json();
        if (!res.ok() || !body.data?.id) {
          throw new Error(`Failed to create fixture "${name}": ${res.status()} ${JSON.stringify(body)}`);
        }
        return Number(body.data.id);
      }

      apptAId = await schedule(Number(clientA.id), '08:00', 'Turno E2E reprogramar — A');
      apptBId = await schedule(Number(clientB.id), '09:00', 'Turno E2E reprogramar — B');

      await context.close();
    });

    test('reschedule via detail panel + form to a free slot persists the new time', async ({ page }) => {
      await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
      await page.getByRole('link', { name: es.nav.calendar }).click();
      await expect(page.locator('.fc')).toBeVisible();

      await navigateCalendarToAppointment(page, apptAId);
      await page.locator(`[data-testid="appt-${apptAId}"]`).first().click();

      await expect(page.getByText(es.calendar.detailTitle)).toBeVisible({ timeout: 10_000 });
      await page.getByRole('button', { name: es.calendar.reschedule }).click();

      const startInput = page.locator('#appt-start');
      await expect(startInput).toBeVisible({ timeout: 10_000 });
      await fillTime(page, 'appt-start', '10:00');

      const rescheduleResponse = page.waitForResponse(
        (r) => r.url().includes(`/appointments/${apptAId}/reschedule`) && r.request().method() === 'POST',
        { timeout: 15_000 },
      );
      await page.getByRole('button', { name: es.actions.save }).click();
      const resp = await rescheduleResponse;
      expect(resp.status()).toBe(200);
      const body = await resp.json();
      expect(body.success).toBe(true);

      const startsAt = new Date(body.data.starts_at);
      const hhmm = startsAt.toLocaleTimeString('es-AR', {
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Argentina/Buenos_Aires',
      });
      expect(hhmm).toBe('10:00');
    });

    test('rescheduling onto a conflicting slot shows the sobreturno dialog and confirms with override', async ({ page }) => {
      await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
      await page.getByRole('link', { name: es.nav.calendar }).click();
      await expect(page.locator('.fc')).toBeVisible();

      // apptA is at 10:00 after the previous test; move it onto apptB's 09:00 slot.
      await navigateCalendarToAppointment(page, apptAId);
      await page.locator(`[data-testid="appt-${apptAId}"]`).first().click();
      await expect(page.getByText(es.calendar.detailTitle)).toBeVisible({ timeout: 10_000 });
      await page.getByRole('button', { name: es.calendar.reschedule }).click();

      const startInput = page.locator('#appt-start');
      await expect(startInput).toBeVisible({ timeout: 10_000 });
      await fillTime(page, 'appt-start', '09:00');

      const firstAttempt = page.waitForResponse(
        (r) => r.url().includes(`/appointments/${apptAId}/reschedule`) && r.request().method() === 'POST',
        { timeout: 15_000 },
      );
      await page.getByRole('button', { name: es.actions.save }).click();
      await firstAttempt;

      const overrideButton = page.locator('button', { hasText: es.actions.bookAnyway });
      await expect(overrideButton).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('text=Este horario se superpone con un turno existente')).toBeVisible();

      const confirmAttempt = page.waitForResponse(
        (r) => r.url().includes(`/appointments/${apptAId}/reschedule`) && r.request().method() === 'POST',
        { timeout: 15_000 },
      );
      await overrideButton.click();
      const resp = await confirmAttempt;
      expect(resp.status()).toBe(200);
      const body = await resp.json();
      expect(body.success).toBe(true);
      expect(body.data).not.toHaveProperty('requires_override');
      expect(body.data.override_conflict).toBe(true);
    });
  });
});
