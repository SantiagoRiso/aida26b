import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  login,
  DEMO_ACCOUNTS,
  findProfessionalId,
  findServiceId,
  findClientId,
  scheduleViaApi,
  getAppointment,
  getBalance,
  stateLabelEs,
  toastEs,
  es,
  isoDaysFromNow,
} from './helpers';
import { DEMO_PASSWORD, DEMO_SERVICE_NAMES } from '../../shared/src/dev-fixtures';

/**
 * The dashboard "current appointment" settle card — the money path with zero prior coverage.
 * Settled here as the professional themselves (demo_pro / Marge, the SSoT professional account),
 * so the card is self-scoped to their own turnos. Three started turnos (dated in the seed's past
 * week so `canSettle` is true) let each outcome be exercised once:
 *   Pagó   → complete + a payment ledger entry
 *   No pagó → complete only (the completion charge posts, no payment)
 *   Ausente → no_show (never charges)
 * Fixtures use no-relation clients untouched by other specs.
 */
const SERVICE = DEMO_SERVICE_NAMES.sesion; // Marge offers "Sesión…"
const DURATION = 50;
const PAST = isoDaysFromNow(-6);

// Scopes to a single settle card (one card per current turno) by its payment input.
function settleCard(page: Page, id: number) {
  return page.locator('div.border-accent', { has: page.locator(`#pay-${id}`) });
}

async function openDashboardAsMarge(page: Page, id: number) {
  await login(page, DEMO_ACCOUNTS.professionalUser.username, DEMO_PASSWORD);
  await page.getByRole('link', { name: es.nav.dashboard }).click();
  await expect(settleCard(page, id).locator(`#pay-${id}`)).toBeVisible({ timeout: 15_000 });
}

test.describe('Dashboard settle card — Pagó / No pagó / Ausente', () => {
  let paidId: number;
  let unpaidId: number;
  let absentId: number;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const admin = await ctx.newPage();
    await login(admin, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    const professional_user_id = await findProfessionalId(admin, 'Dra. Marge Bouvier');
    const service_id = await findServiceId(admin, SERVICE);
    const [ruth, luann, agnes] = await Promise.all([
      findClientId(admin, 'Ruth Powers'),
      findClientId(admin, 'Luann Van Houten'),
      findClientId(admin, 'Agnes Skinner'),
    ]);

    const base = { professional_user_id, service_id, duration_minutes: DURATION, date: PAST };
    paidId   = await scheduleViaApi(admin, { ...base, client_user_id: ruth,  start: '09:00', name: 'E2E settle pagó' });
    unpaidId = await scheduleViaApi(admin, { ...base, client_user_id: luann, start: '10:00', name: 'E2E settle no pagó' });
    absentId = await scheduleViaApi(admin, { ...base, client_user_id: agnes, start: '11:00', name: 'E2E settle ausente' });
    await ctx.close();
  });

  test('Pagó → completes the turno and posts a payment ledger entry', async ({ page }) => {
    await openDashboardAsMarge(page, paidId);
    const { price } = await getAppointment(page, paidId);
    const clientBalanceBefore = await getBalance(page, await clientOf(page, paidId));

    const card = settleCard(page, paidId);
    const txn = page.waitForResponse((r) => r.url().includes(`/appointments/${paidId}/transition`) && r.request().method() === 'POST');
    const pay = page.waitForResponse((r) => r.url().endsWith('/api/ledger') && r.request().method() === 'POST');
    await card.locator(`#pay-${paidId}`).fill('3000');
    await card.getByRole('button', { name: es.dashboard.paid, exact: true }).click();
    expect((await txn).status()).toBe(200);
    expect((await pay).status()).toBeLessThan(300);

    await expect(page.getByText(toastEs.paymentRegistered)).toBeVisible({ timeout: 10_000 });
    expect((await getAppointment(page, paidId)).state).toBe('completed');
    const after = await getBalance(page, await clientOf(page, paidId));
    // charge(price) − payment(3000).
    expect(after - clientBalanceBefore).toBeCloseTo(Number(price) - 3000, 2);
  });

  test('No pagó → completes the turno and posts the charge, no payment', async ({ page }) => {
    await openDashboardAsMarge(page, unpaidId);
    const { price } = await getAppointment(page, unpaidId);
    const before = await getBalance(page, await clientOf(page, unpaidId));

    const card = settleCard(page, unpaidId);
    const txn = page.waitForResponse((r) => r.url().includes(`/appointments/${unpaidId}/transition`) && r.request().method() === 'POST');
    await card.getByRole('button', { name: es.dashboard.notPaid, exact: true }).click();
    expect((await txn).status()).toBe(200);

    await expect(page.getByText(toastEs.attendanceRegistered)).toBeVisible({ timeout: 10_000 });
    expect((await getAppointment(page, unpaidId)).state).toBe('completed');
    expect((await getBalance(page, await clientOf(page, unpaidId))) - before).toBeCloseTo(Number(price), 2);
  });

  test('Ausente → marks no_show and never charges', async ({ page }) => {
    await openDashboardAsMarge(page, absentId);
    const before = await getBalance(page, await clientOf(page, absentId));

    const card = settleCard(page, absentId);
    const txn = page.waitForResponse((r) => r.url().includes(`/appointments/${absentId}/transition`) && r.request().method() === 'POST');
    await card.getByRole('button', { name: stateLabelEs('no_show'), exact: true }).click();
    expect((await txn).status()).toBe(200);

    await expect(page.getByText(toastEs.absenceRegistered)).toBeVisible({ timeout: 10_000 });
    expect((await getAppointment(page, absentId)).state).toBe('no_show');
    expect((await getBalance(page, await clientOf(page, absentId))) - before).toBeCloseTo(0, 2);
  });
});

// The appointment's client id, read from the API (needed for the balance assertion).
async function clientOf(page: Page, id: number): Promise<number> {
  const res = await page.request.get(`/api/appointments/${id}`);
  return Number((await res.json()).data.client_user_id);
}
