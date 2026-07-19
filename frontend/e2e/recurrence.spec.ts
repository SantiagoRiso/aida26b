import { test, expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import {
  login, DEMO_ACCOUNTS, selectFromCombobox, fillDate, findProfessionalId, findServiceId, findClientId,
  isoDaysFromNow, getBalance, stateLabelEs, es,
} from './helpers';
import { DEMO_SERVICE_NAMES, shiftSeedDate } from '../../shared/src/dev-fixtures';
import { weekdayOf } from '../../shared/src/ssot/domain/availability';

/**
 * First e2e coverage for recurring appointments (create → virtual occurrences → complete → cancel
 * with scope). Uses Dra. Edna Krabappel (untouched by any other spec) with two no-relation clients
 * so the two series below can't collide with each other or with any other spec's fixtures.
 *
 * The "complete" step needs an occurrence whose start time has already passed (canCompleteAppointment
 * gates on starts_at <= now), but the create-time DateField floors at today — the UI can't pick a
 * past date. So series B is seeded directly via the same POST /appointments/series the form calls,
 * exactly how every other lifecycle spec seeds a PAST fixture via the staff API instead of the form
 * (see appointment-transitions.spec.ts). Series A goes through the real form to cover creation +
 * virtual rendering; series B covers complete/cancel through the detail panel UI.
 */
const PRO_NAME = 'Dra. Edna Krabappel';
const CLIENT_A_NAME = 'Cletus Spuckler';  // series A — created live through the form
const CLIENT_B_NAME = 'Reverend Lovejoy'; // series B — API-seeded, anchored in the past
const SERIES_COUNT = 3;

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

// Resets to the calendar's default view, then clicks next/prev (re-fetching each time, same as
// navigateCalendarToAppointment in helpers.ts) until the target testid is visible. Virtual
// occurrences carry a `virtual:<series>:<date>` key instead of a numeric id, so this mirrors the
// helper rather than forcing a string through its `number` signature.
async function navigateToOccurrence(
  page: Page,
  testId: string,
  direction: 'next' | 'prev' = 'next',
  maxClicks = 12,
): Promise<Locator> {
  await page.getByRole('link', { name: es.nav.calendar }).click();
  await expect(page.locator('.fc')).toBeVisible({ timeout: 10_000 });
  const target = page.locator(`[data-testid="${testId}"]`);
  for (let i = 0; i < maxClicks; i++) {
    if (await target.first().isVisible().catch(() => false)) break;
    const nextFetch = page.waitForResponse(
      (r) => r.url().includes('/appointments') && r.request().method() === 'GET',
      { timeout: 10_000 },
    ).catch(() => null);
    await page.locator(`.fc-${direction}-button`).click();
    await nextFetch;
  }
  await expect(target.first()).toBeVisible({ timeout: 10_000 });
  return target.first();
}

async function openOccurrenceDetail(page: Page, testId: string, direction: 'next' | 'prev' = 'next'): Promise<void> {
  const target = await navigateToOccurrence(page, testId, direction);
  await target.click();
  await expect(page.getByText(es.calendar.detailTitle)).toBeVisible({ timeout: 10_000 });
}

test.describe('Recurring appointment series', () => {
  let profId: number;
  let sesionServiceId: number;
  let clientAId: number;
  let clientBId: number;
  let seriesBId: number;
  let seriesBDate0: string; // already started — completable
  let seriesBDate1: string; // future — cancel-with-scope target
  let seriesBDate2: string; // future — must stop being generated too

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const admin = await ctx.newPage();
    await login(admin, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    profId = await findProfessionalId(admin, PRO_NAME);
    sesionServiceId = await findServiceId(admin, DEMO_SERVICE_NAMES.sesion);
    clientAId = await findClientId(admin, CLIENT_A_NAME);
    clientBId = await findClientId(admin, CLIENT_B_NAME);

    // Before the dense demo-seed window (see helpers.ts isoDaysFromNow) — guaranteed conflict-free.
    seriesBDate0 = isoDaysFromNow(-6);
    seriesBDate1 = addDays(seriesBDate0, 7);
    seriesBDate2 = addDays(seriesBDate0, 14);

    const res = await admin.request.post('/api/appointments/series', {
      data: {
        client_user_id: clientBId,
        professional_user_id: profId,
        service_id: sesionServiceId,
        frequency: 'weekly',
        interval: 1,
        weekday: weekdayOf(seriesBDate0),
        start_time: '10:00',
        start_date: seriesBDate0,
        duration_minutes: 50,
        end_kind: 'count',
        end_count: SERIES_COUNT,
      },
    });
    const body = await res.json();
    if (!res.ok() || !body.data?.series?.id) {
      throw new Error(`series fixture failed: ${res.status()} ${JSON.stringify(body)}`);
    }
    seriesBId = Number(body.data.series.id);
    await ctx.close();
  });

  test('create a weekly series, see virtual occurrences, complete one, cancel the rest', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    // --- 1. Create a recurring series through the real "Nuevo turno" form ---
    await page.getByRole('link', { name: es.nav.calendar }).click();
    await expect(page.locator('.fc')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: es.calendar.newAppointment }).click();

    await selectFromCombobox(page, 'appt-client', CLIENT_A_NAME);
    await selectFromCombobox(page, 'appt-prof', PRO_NAME);
    // Edna offers two services, so the Selector stays a real <select> (not the single-option
    // read-only collapse other specs rely on).
    await page.locator('#appt-service').selectOption({ label: DEMO_SERVICE_NAMES.sesion });

    const slotButton = page.locator('button').filter({ hasText: /^\d{2}:\d{2}/ }).first();
    async function fillDateAndWaitForAvailability(date: string): Promise<void> {
      const availResponse = page.waitForResponse(
        (r) => r.url().includes('/api/availability') && r.request().method() === 'GET',
        { timeout: 15_000 },
      ).catch(() => null);
      await fillDate(page, date);
      await availResponse;
    }

    // Future, in-window dates past the dense-seed window (mirrors appointment-create.spec.ts).
    let seriesADate0 = shiftSeedDate('2026-08-25');
    await fillDateAndWaitForAvailability(seriesADate0);
    let slotVisible = await slotButton.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!slotVisible) {
      seriesADate0 = shiftSeedDate('2026-08-26');
      await fillDateAndWaitForAvailability(seriesADate0);
      slotVisible = await slotButton.isVisible({ timeout: 5_000 }).catch(() => false);
    }
    expect(slotVisible, 'Expected a free slot for Dra. Edna Krabappel').toBe(true);
    await slotButton.click();

    await page.getByRole('checkbox', { name: es.calendar.recurrenceToggle }).check();
    await page.locator('#appt-end-count').fill(String(SERIES_COUNT));

    const seriesCreate = page.waitForResponse(
      (r) => r.url().includes('/appointments/series') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await page.getByRole('button', { name: es.actions.save }).click();
    const createResp = await seriesCreate;
    expect(createResp.status()).toBe(201);
    const createBody = await createResp.json();
    expect(createBody.success).toBe(true);
    const seriesA = createBody.data.series;
    expect(Number(seriesA.client_user_id)).toBe(clientAId);
    expect(Number(seriesA.professional_user_id)).toBe(profId);
    expect(Number(seriesA.service_id)).toBe(sesionServiceId);
    expect(seriesA.frequency).toBe('weekly');
    expect(seriesA.end_kind).toBe('count');
    expect(Number(seriesA.end_count)).toBe(SERIES_COUNT);
    expect(Array.isArray(createBody.data.preview.skipped)).toBe(true);
    const seriesAId = Number(seriesA.id);
    seriesADate0 = seriesA.start_date; // server-confirmed anchor date

    // Report panel always renders (its heading isn't conditional on whether anything was skipped).
    await expect(page.getByTestId('series-report')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('heading', { name: es.calendar.seriesSkippedTitle })).toBeVisible();
    await page.getByTestId('series-report').getByRole('button', { name: es.actions.close }).click();

    // --- 2. Multiple occurrences render on the calendar, styled as virtual ---
    const seriesADate1 = addDays(seriesADate0, 7);
    const occ0 = await navigateToOccurrence(page, `appt-virtual:${seriesAId}:${seriesADate0}`);
    await expect(occ0).toHaveClass(/fc-virtual-occurrence/);
    const occ1 = await navigateToOccurrence(page, `appt-virtual:${seriesAId}:${seriesADate1}`);
    await expect(occ1).toHaveClass(/fc-virtual-occurrence/);

    // --- 3. Complete an already-started occurrence (series B) → materializes + posts a ledger charge ---
    const balanceBefore = await getBalance(page, clientBId);
    await openOccurrenceDetail(page, `appt-virtual:${seriesBId}:${seriesBDate0}`, 'prev');

    const transitionResp = page.waitForResponse(
      (r) => r.url().includes('/transition') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await page.getByRole('button', { name: es.calendar.complete, exact: true }).click();
    const completedResp = await transitionResp;
    expect(completedResp.status()).toBe(200);
    const completed = (await completedResp.json()).data;
    expect(completed.state).toBe('completed');
    expect(String(completed.series_id)).toBe(String(seriesBId));

    await expect(page.getByText(stateLabelEs('completed')).first()).toBeVisible({ timeout: 10_000 });
    const balanceAfter = await getBalance(page, clientBId);
    expect(balanceAfter - balanceBefore).toBeCloseTo(Number(completed.price), 2);

    // The panel's backdrop covers the whole viewport (fixed inset-0) — close it before navigating,
    // or the next "Calendario" click is blocked.
    await page.getByRole('button', { name: es.actions.close, exact: true }).click();
    await expect(page.getByText(es.calendar.detailTitle)).toBeHidden({ timeout: 10_000 });

    // --- 4. Cancel a later occurrence with "this and future" scope → later occurrences disappear ---
    await openOccurrenceDetail(page, `appt-virtual:${seriesBId}:${seriesBDate1}`, 'next');
    await page.getByRole('button', { name: es.calendar.cancel, exact: true }).click();

    const scopeDialog = page.getByRole('dialog').filter({ hasText: es.calendar.scopeDialogTitle });
    await expect(scopeDialog.getByRole('button', { name: es.calendar.scopeFuture })).toBeVisible({ timeout: 10_000 });
    const endResp = page.waitForResponse(
      (r) => r.url().includes(`/appointments/series/${seriesBId}/end`) && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await scopeDialog.getByRole('button', { name: es.calendar.scopeFuture }).click();
    expect((await endResp).status()).toBe(200);

    // The canceled occurrence's own week refetches immediately as part of the scope action.
    await expect(page.locator(`[data-testid="appt-virtual:${seriesBId}:${seriesBDate1}"]`)).toHaveCount(0);

    // A later, still-virtual occurrence must stop being generated too — checked at the API instead
    // of a second multi-week navigation for a state the UI would only show identically.
    const afterEnd = await page.request.get(
      `/api/appointments?date_from=${seriesBDate2}&date_to=${seriesBDate2}&professional_user_id=${profId}`,
    );
    const afterEndRows = (await afterEnd.json()).data as Array<{ series_id?: string | null }>;
    expect(afterEndRows.some((a) => a.series_id === String(seriesBId))).toBe(false);
  });
});
