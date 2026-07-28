import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
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
  isoDaysFromNow,
  es,
} from './helpers';
import { DEMO_PASSWORD, DEMO_SERVICE_NAMES, shiftSeedDate } from '../../shared/src/dev-fixtures';

/**
 * Appointment lifecycle transitions driven through the calendar detail panel — the states the
 * available from the detail panel. Every
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
// Scan window for the request-endpoint fixtures below: past the seed's dense-fill window, inside
// the 60-day client booking window.
const SCAN_FROM = shiftSeedDate('2026-08-25');
const SCAN_TO = isoDaysFromNow(59);

// The client request endpoint (requestViaApi) cannot override conflicts, so its fixtures need a
// genuinely open slot, not an assumed-free hardcoded time. beforeAll reruns on every CI retry (a
// fresh worker re-executes it from scratch) and nothing here cleans up what a prior attempt already
// created, so a fixed date/time is only actually free on the very first attempt; any retry then
// collides with the previous attempt's own leftover appointment. Scanning /api/availability (the
// same idiom calendar-drag-override.spec.ts uses) sidesteps that: a retry's scan simply lands on
// whatever is still open, self-healing run after run instead of assuming the slot is free.
async function findFreeSlots(
  page: Page,
  professionalId: number,
  serviceId: number,
  count: number,
): Promise<{ date: string; start: string }[]> {
  const res = await page.request.get(
    `/api/availability?owner=prof:${professionalId}&service=${serviceId}&date_from=${SCAN_FROM}&date_to=${SCAN_TO}`,
  );
  const days = (await res.json()).data as Array<{ date: string; slots: Array<{ start: string; end: string }> }>;
  const found: { date: string; start: string }[] = [];
  for (const day of days) {
    for (const slot of day.slots) {
      found.push({ date: day.date, start: slot.start });
      if (found.length === count) return found;
    }
  }
  throw new Error(
    `Not enough free slots for professional ${professionalId} between ${SCAN_FROM} and ${SCAN_TO} ` +
    `(found ${found.length}, needed ${count})`,
  );
}

test.describe('Appointment lifecycle transitions via the detail panel', () => {
  let completeId: number;
  let noShowId: number;
  let cancelId: number;
  let approveId: number;
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
    const [rejectSlot, approveSlot] = await findFreeSlots(admin, professional_user_id, service_id, 2);
    await adminContext.close();

    // 'requested' is only reachable via the client request endpoint — create it as the client.
    const clientContext = await browser.newContext();
    const client = await clientContext.newPage();
    await login(client, 'demo_client34', DEMO_PASSWORD); // Jimbo Jones — untouched by other specs
    rejectId = await requestViaApi(client, {
      professional_user_id, service_id, duration_minutes: DURATION,
      date: rejectSlot.date, start: rejectSlot.start, name: 'E2E rechazar',
    });
    approveId = await requestViaApi(client, {
      professional_user_id, service_id, duration_minutes: DURATION,
      date: approveSlot.date, start: approveSlot.start, name: 'E2E aprobar',
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

  test('approve a requested turno → scheduled', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await openAppointmentDetail(page, approveId, 'next');

    const responsePromise = page.waitForResponse(
      (r) => r.url().includes(`/appointments/${approveId}/approve`) && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await page.getByRole('button', { name: es.calendar.approve, exact: true }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    expect((await response.json()).data.state).toBe('scheduled');

    await expect(page.getByText(stateLabelEs('scheduled')).first()).toBeVisible({ timeout: 10_000 });
    expect((await getAppointment(page, approveId)).state).toBe('scheduled');
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

  test('a not-yet-started turno does not offer the complete action', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await openAppointmentDetail(page, tooEarlyId, 'next');

    await expect(page.getByRole('button', { name: es.calendar.complete, exact: true })).toHaveCount(0);
    expect((await getAppointment(page, tooEarlyId)).state).toBe('scheduled');
  });
});
