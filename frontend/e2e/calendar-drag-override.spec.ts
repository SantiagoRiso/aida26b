import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  login,
  DEMO_ACCOUNTS,
  findProfessionalId,
  findClientId,
  findServiceId,
  scheduleViaApi,
  navigateCalendarToAppointment,
  fillTime,
  isoDaysFromNow,
  es,
} from './helpers';
import { DEMO_SERVICE_NAMES } from '../../shared/src/dev-fixtures';

/**
 * The conflict-override dialog on reschedule. The *confirm* (override) half lives in
 * calendar-reschedule.spec.ts; this covers the *cancel* (revert) half — cancelling must abort the
 * move and leave the turno exactly where it was.
 *
 * Reschedule is driven through the detail-panel form, not a calendar drag: FullCalendar / custom
 * timegrid drag is unreliable under Playwright in this environment (see the note in
 * calendar-reschedule.spec.ts). The drag-only behaviours the plan lists alongside this — the
 * cross-midnight rejection and the no-op snap-back — are pure functions unit-tested in
 * calendarGrid.test.ts (exceedsEndOfDay) rather than exercised through a flaky drag here.
 *
 * Fixtures use Dr. Julius Hibbert (the proven medico professional) on a now+N date (override schedule,
 * so not window-bound) past the seed's dense fill and within the calendar's forward-nav range, with
 * clients no other spec touches — so the only conflict on that day is this spec's own two turnos.
 */
const PROF = 'Julius Hibbert';
const RANGE_START = isoDaysFromNow(45);
const RANGE_END = isoDaysFromNow(52);
let fixtureDate: string;
let startA: string;
let startB: string;

async function readStartHHMM(page: Page, apptId: number): Promise<string> {
  const res = await page.request.get(`/api/appointments/${apptId}`);
  const { data } = await res.json();
  return new Date(data.starts_at).toLocaleTimeString('es-AR', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Argentina/Buenos_Aires',
  });
}

test.describe('Calendar conflict override — cancel reverts the reschedule', () => {
  let apptAId: number;
  let apptBId: number;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    const [professionalId, serviceId, clientA, clientB] = await Promise.all([
      findProfessionalId(page, PROF),
      findServiceId(page, DEMO_SERVICE_NAMES.medico),
      findClientId(page, 'Milhouse Van Houten'),
      findClientId(page, 'Nelson Muntz'),
    ]);

    const availabilityRes = await page.request.get(
      `/api/availability?owner=prof:${professionalId}&date_from=${RANGE_START}&date_to=${RANGE_END}`,
    );
    const availability = (await availabilityRes.json()).data as Array<{
      date: string;
      slots: Array<{ start: string; end: string }>;
    }>;
    const day = availability.find((candidate) => candidate.slots.some((slot) => {
      const [startHour, startMinute] = slot.start.split(':').map(Number);
      const [endHour, endMinute] = slot.end.split(':').map(Number);
      return (endHour! * 60 + endMinute!) - (startHour! * 60 + startMinute!) >= 60;
    }));
    if (!availabilityRes.ok() || !day) throw new Error('No one-hour interval available for override-cancel fixture');
    const interval = day.slots.find((slot) => {
      const [startHour, startMinute] = slot.start.split(':').map(Number);
      const [endHour, endMinute] = slot.end.split(':').map(Number);
      return (endHour! * 60 + endMinute!) - (startHour! * 60 + startMinute!) >= 60;
    })!;
    fixtureDate = day.date;
    startA = interval.start;
    const [hour, minute] = startA.split(':').map(Number);
    const secondStart = hour! * 60 + minute! + 30;
    startB = `${String(Math.floor(secondStart / 60)).padStart(2, '0')}:${String(secondStart % 60).padStart(2, '0')}`;

    const seed = (clientId: number, start: string, name: string) =>
      scheduleViaApi(page, {
        professional_user_id: professionalId,
        service_id: serviceId,
        client_user_id: clientId,
        date: fixtureDate,
        start,
        duration_minutes: 30,
        name,
        override: false,
      });
    apptAId = await seed(clientA, startA, 'Turno E2E override-cancel — A');
    apptBId = await seed(clientB, startB, 'Turno E2E override-cancel — B');

    await context.close();
  });

  test('cancelling the sobreturno dialog leaves the turno at its original time', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    expect(await readStartHHMM(page, apptAId)).toBe(startA);

    await page.getByRole('link', { name: es.nav.calendar }).click();
    await expect(page.locator('.fc')).toBeVisible();

    // Move A (08:00) onto B's occupied 09:00 slot → the backend returns a conflict verdict.
    await navigateCalendarToAppointment(page, apptAId);
    await page.locator(`[data-testid="appt-${apptAId}"]`).first().click();
    await expect(page.getByText(es.calendar.detailTitle)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: es.calendar.reschedule }).click();

    await expect(page.locator('#appt-start')).toBeVisible({ timeout: 10_000 });
    await fillTime(page, 'appt-start', startB);

    const firstAttempt = page.waitForResponse(
      (r) => r.url().includes(`/appointments/${apptAId}/reschedule`) && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await page.getByRole('button', { name: es.actions.save }).click();
    await firstAttempt;

    // The sobreturno dialog offers the override; cancel it instead. Scope buttons to that dialog
    // (identified by the override label) so a stray Cancelar elsewhere can't be hit.
    const dialog = page.getByRole('dialog').filter({ hasText: es.actions.bookAnyway });
    await expect(dialog.getByRole('button', { name: es.actions.bookAnyway })).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole('button', { name: es.actions.cancel }).click();
    await expect(page.locator('button', { hasText: es.actions.bookAnyway })).toBeHidden();

    // No second reschedule request fired and the turno stayed at its discovered free slot, unflagged.
    expect(await readStartHHMM(page, apptAId)).toBe(startA);
    const res = await page.request.get(`/api/appointments/${apptAId}`);
    expect((await res.json()).data.override_conflict).toBe(false);
    // B is untouched too.
    expect(await readStartHHMM(page, apptBId)).toBe(startB);
  });
});
