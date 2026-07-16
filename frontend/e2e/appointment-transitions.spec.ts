import { test, expect } from '@playwright/test';
import {
  login,
  DEMO_ACCOUNTS,
  openAppointmentDetail,
  findProfessionalId,
  findServiceId,
  findClientId,
  scheduleViaApi,
  requestViaApi,
  getAppointment,
  stateLabelEs,
  toastEs,
  isoDaysFromNow,
  es,
} from './helpers';
import { DEMO_PASSWORD, DEMO_SERVICE_NAMES, shiftSeedDate } from '../../shared/src/dev-fixtures';

/**
 * Appointment lifecycle transitions driven through the calendar detail panel — the states the
 * existing suite leaves untested (approve is covered by appointment-lifecycle.spec.ts). Every
 * fixture is self-seeded via the staff API onto Dra. Lisa Simpson (demo_pro3) with no-relation
 * clients (Ruth Powers / Luann Van Houten / Agnes Skinner / Jimbo Jones), none of which any other
 * spec reads or mutates — safe under the serial (workers:1) shared-dataset run.
 *
 * complete / no_show need a turno that has already started (the `too_early` gate), so those fixtures
 * sit a few days in the past; cancel / reject have no time gate and sit in the future. Those are
 * override-scheduled (weekday-agnostic), so they use now-relative offsets.
 */
const PRO_NAME = 'Dra. Lisa Simpson';      // mirrors seed-demo.ts demo_pro3
const SERVICE = DEMO_SERVICE_NAMES.nutricion;
const DURATION = 40;
const PAST = isoDaysFromNow(-6);
const FUTURE = isoDaysFromNow(21);
// The client request endpoint cannot override conflicts, so the reject fixture needs a genuinely
// free, slot-aligned slot on Lisa's working day. shiftSeedDate keeps the authored Tuesday 08:00
// (she works Mon-Thu) aligned with the seed's shift, landing past the dense-fill window and inside
// the 60-day booking window.
const REQUEST_DATE = shiftSeedDate('2026-08-25');

test.describe('Appointment lifecycle transitions via the detail panel', () => {
  let completeId: number;
  let noShowId: number;
  let cancelId: number;
  let rejectId: number;
  let tooEarlyId: number;

  test.beforeAll(async ({ browser }) => {
    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    await login(admin, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    const professional_user_id = await findProfessionalId(admin, PRO_NAME);
    const service_id = await findServiceId(admin, SERVICE);
    const [ruth, luann, agnes] = await Promise.all([
      findClientId(admin, 'Ruth Powers'),
      findClientId(admin, 'Luann Van Houten'),
      findClientId(admin, 'Agnes Skinner'),
    ]);

    const base = { professional_user_id, service_id, duration_minutes: DURATION };
    completeId  = await scheduleViaApi(admin, { ...base, client_user_id: ruth,  date: PAST,   start: '08:00', name: 'E2E completar' });
    noShowId    = await scheduleViaApi(admin, { ...base, client_user_id: luann, date: PAST,   start: '09:20', name: 'E2E ausente' });
    cancelId    = await scheduleViaApi(admin, { ...base, client_user_id: agnes, date: FUTURE, start: '10:00', name: 'E2E cancelar' });
    tooEarlyId  = await scheduleViaApi(admin, { ...base, client_user_id: ruth,  date: FUTURE, start: '11:00', name: 'E2E too-early' });
    await adminContext.close();

    // 'requested' is only reachable via the client request endpoint — create it as the client.
    const clientContext = await browser.newContext();
    const client = await clientContext.newPage();
    await login(client, 'demo_client34', DEMO_PASSWORD); // Jimbo Jones — untouched by other specs
    rejectId = await requestViaApi(client, {
      professional_user_id, service_id, duration_minutes: DURATION,
      date: REQUEST_DATE, start: '08:00', name: 'E2E rechazar',
    });
    await clientContext.close();
  });

  // Drives one detail-panel transition button and asserts the API result, the durable DB state,
  // and the badge the panel re-renders.
  async function transitionViaPanel(
    page: import('@playwright/test').Page,
    id: number,
    buttonName: string,
    expectedState: string,
    direction: 'next' | 'prev',
  ) {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await openAppointmentDetail(page, id, direction);

    const responsePromise = page.waitForResponse(
      (r) => r.url().includes(`/appointments/${id}/transition`) && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await page.getByRole('button', { name: buttonName, exact: true }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    expect((await response.json()).data.state).toBe(expectedState);

    // Terminal badge the panel re-renders, and an independent DB re-read.
    await expect(page.getByText(stateLabelEs(expectedState)).first()).toBeVisible({ timeout: 10_000 });
    expect((await getAppointment(page, id)).state).toBe(expectedState);
  }

  test('reject a requested turno → rejected', async ({ page }) => {
    await transitionViaPanel(page, rejectId, es.calendar.reject, 'rejected', 'next');
  });

  test('cancel a scheduled turno → canceled', async ({ page }) => {
    await transitionViaPanel(page, cancelId, es.calendar.cancel, 'canceled', 'next');
  });

  test('complete a started turno → completed', async ({ page }) => {
    await transitionViaPanel(page, completeId, es.calendar.complete, 'completed', 'prev');
  });

  test('mark a started turno as no_show → no_show', async ({ page }) => {
    await transitionViaPanel(page, noShowId, es.calendar.noShow, 'no_show', 'prev');
  });

  test('completing a not-yet-started turno is refused with the too-early message', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await openAppointmentDetail(page, tooEarlyId, 'next');

    const responsePromise = page.waitForResponse(
      (r) => r.url().includes(`/appointments/${tooEarlyId}/transition`) && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await page.getByRole('button', { name: es.calendar.complete, exact: true }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(422);
    expect((await response.json()).error.code).toBe('too_early');

    await expect(page.getByText(toastEs.completeTooEarly)).toBeVisible({ timeout: 10_000 });
    // Unchanged: still scheduled.
    expect((await getAppointment(page, tooEarlyId)).state).toBe('scheduled');
  });
});
