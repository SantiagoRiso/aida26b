import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  login,
  DEMO_ACCOUNTS,
  findProfessionalId,
  findClientId,
  findServiceId,
  scheduleViaApi,
  isoDaysFromNow,
  es,
} from './helpers';
import { DEMO_SERVICE_NAMES } from '../../shared/src/dev-fixtures';

/**
 * DashboardView renders three distinct role layouts + a shared conflict panel. The settle card
 * (needs an in-progress turno) is covered by dashboard-settle.spec.ts, so it's out of scope here.
 *
 * The conflict-panel test self-seeds: a turno for Dra. Marge Bouvier (demo_pro) plus an all-day
 * business closure over it makes the turno server-computed `in_conflict`, so her dashboard surfaces
 * the panel. Date 2026-09-20 is clear of every other spec's fixtures.
 */
// now+N (override schedule, so not window-bound) — past the seed's dense fill and clear of the other
// specs' fixture offsets, so this spec's closure flags only its own turno.
const CONFLICT_DATE = isoDaysFromNow(62);
let margeId: number;
let conflictApptId: number;
let closureId: number;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

  const [profId, serviceId, clientId] = await Promise.all([
    findProfessionalId(page, 'Marge Bouvier'),
    findServiceId(page, DEMO_SERVICE_NAMES.sesion),
    findClientId(page, 'Ralph Wiggum'),
  ]);
  margeId = profId;
  conflictApptId = await scheduleViaApi(page, {
    professional_user_id: profId,
    service_id: serviceId,
    client_user_id: clientId,
    date: CONFLICT_DATE,
    start: '10:00',
    duration_minutes: 50,
    name: 'e2e dashboard conflict',
  });
  // An all-day closure over that date makes the turno in_conflict (computed server-side).
  const closureRes = await page.request.post('/api/business-closures', {
    data: { exception_date: CONFLICT_DATE, start_time: null, end_time: null, reason: 'e2e dashboard' },
  });
  if (!closureRes.ok()) throw new Error(`closure seed failed: ${closureRes.status()}`);
  closureId = Number((await closureRes.json()).data.id);

  await context.close();
});

test.afterAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
  const closureRes = await page.request.delete(`/api/business-closures/${closureId}`);
  if (!closureRes.ok() && closureRes.status() !== 404) {
    throw new Error(`closure fixture cleanup failed: ${closureRes.status()}`);
  }
  await context.close();
});

async function isFlagged(page: Page, apptId: number): Promise<boolean> {
  const res = await page.request.get(`/api/appointments?professional_user_id=${margeId}&conflicting=true&limit=500`);
  const body = await res.json();
  return (body.data ?? []).some((r: { id: string | number }) => Number(r.id) === apptId);
}

test.describe('Dashboard — role variants', () => {
  test('admin sees the three stat tiles, quick actions, and recent activity', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await expect(page).toHaveURL(/\/staff\/dashboard/);

    await expect(page.getByText(es.dashboard.appointmentsToday)).toBeVisible();
    await expect(page.getByText(es.dashboard.pendingRequests)).toBeVisible();
    await expect(page.getByText(es.dashboard.recentAuditEvents)).toBeVisible();
    await expect(page.getByRole('heading', { name: es.dashboard.recentActivity })).toBeVisible();

    // Quick action navigates to the audit screen.
    await page.getByRole('button', { name: es.dashboard.viewAudit }).click();
    await expect(page).toHaveURL(/\/staff\/audit/);
  });

  test('professional sees upcoming turnos and pending requests sections', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.professionalUser.username, DEMO_ACCOUNTS.professionalUser.password);
    await expect(page.getByRole('heading', { name: es.portal.upcomingHeading })).toBeVisible();
    await expect(page.getByRole('heading', { name: es.dashboard.pendingRequests })).toBeVisible();
  });

  test('receptionist sees today/triage sections and Nuevo turno jumps to the calendar', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.receptionistWithGrant.username, DEMO_ACCOUNTS.receptionistWithGrant.password);
    await expect(page.getByRole('heading', { name: es.dashboard.todayAppointments })).toBeVisible();
    await expect(page.getByRole('heading', { name: es.dashboard.requestsToTriage })).toBeVisible();

    await page.getByRole('button', { name: es.actions.newAppointment }).click();
    await expect(page).toHaveURL(/\/staff\/calendar/);
  });

  test('conflict panel lists a flagged turno and Ignorar clears it', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.professionalUser.username, DEMO_ACCOUNTS.professionalUser.password);
    expect(await isFlagged(page, conflictApptId)).toBe(true);

    await expect(page.getByRole('heading', { name: es.dashboard.conflictsHeading })).toBeVisible({ timeout: 10_000 });

    const conflictRow = page.locator(`[data-testid="conflict-${conflictApptId}"]`);
    await expect(conflictRow).toBeVisible();

    const ignoreResp = page.waitForResponse(
      (r) => /\/appointments\/\d+\/ignore-conflict/.test(r.url()) && r.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await conflictRow.getByRole('button', { name: es.dashboard.ignore }).click();
    expect((await ignoreResp).ok()).toBe(true);

    // Acknowledged → drops out of the conflicting list.
    await expect.poll(() => isFlagged(page, conflictApptId)).toBe(false);
  });
});
