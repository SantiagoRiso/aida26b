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
  isoDaysFromNow,
} from './helpers';
import { DEMO_SERVICE_NAMES } from '../../shared/src/dev-fixtures';

/**
 * Ledger integrity of the completion money rule (CLAUDE.md): completing a turno posts exactly one
 * idempotent `charge` for the frozen price; no_show never charges; a turno cannot be completed
 * twice, so it cannot be charged twice. The detail-panel/settle UIs are covered by
 * appointment-transitions and dashboard-settle; this spec asserts the accounting via the API for
 * precision. Fixtures: Dr. Julius Hibbert (demo_pro6) + no-relation clients, dated in the seed's
 * past week so completion isn't blocked by the too-early gate. Balances are asserted as deltas
 * around each operation, so prior charges on a shared client don't matter (serial run).
 */
const SERVICE = DEMO_SERVICE_NAMES.medico; // Julius offers "Consulta médica"
const DURATION = 30;
const PAST = isoDaysFromNow(-6);

async function transition(page: Page, id: number, to: string) {
  return page.request.post(`/api/appointments/${id}/transition`, { data: { to } });
}
async function clientOf(page: Page, id: number): Promise<number> {
  const res = await page.request.get(`/api/appointments/${id}`);
  return Number((await res.json()).data.client_user_id);
}

test.describe('Completion posts the charge; no_show does not; completion is not double-charged', () => {
  let chargeId: number;
  let noChargeId: number;
  let idempId: number;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const admin = await ctx.newPage();
    await login(admin, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    const professional_user_id = await findProfessionalId(admin, 'Dr. Julius Hibbert');
    const service_id = await findServiceId(admin, SERVICE);
    const [ruth, luann, agnes] = await Promise.all([
      findClientId(admin, 'Ruth Powers'),
      findClientId(admin, 'Luann Van Houten'),
      findClientId(admin, 'Agnes Skinner'),
    ]);

    const base = { professional_user_id, service_id, duration_minutes: DURATION, date: PAST };
    chargeId   = await scheduleViaApi(admin, { ...base, client_user_id: ruth,  start: '08:30', name: 'E2E cargo' });
    noChargeId = await scheduleViaApi(admin, { ...base, client_user_id: luann, start: '09:00', name: 'E2E sin cargo' });
    idempId    = await scheduleViaApi(admin, { ...base, client_user_id: agnes, start: '09:30', name: 'E2E idempotente' });
    await ctx.close();
  });

  test('completing a turno raises the client balance by the frozen price', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    const client = await clientOf(page, chargeId);
    const { price } = await getAppointment(page, chargeId);
    const before = await getBalance(page, client);

    const res = await transition(page, chargeId, 'completed');
    expect(res.status()).toBe(200);
    expect((await res.json()).data.state).toBe('completed');

    expect((await getBalance(page, client)) - before).toBeCloseTo(Number(price), 2);
  });

  test('marking a turno no_show never charges the client', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    const client = await clientOf(page, noChargeId);
    const before = await getBalance(page, client);

    const res = await transition(page, noChargeId, 'no_show');
    expect(res.status()).toBe(200);
    expect((await res.json()).data.state).toBe('no_show');

    expect((await getBalance(page, client)) - before).toBeCloseTo(0, 2);
  });

  test('a completed turno cannot be completed (nor charged) again', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    const client = await clientOf(page, idempId);
    const { price } = await getAppointment(page, idempId);
    const before = await getBalance(page, client);

    expect((await transition(page, idempId, 'completed')).status()).toBe(200);
    const afterFirst = await getBalance(page, client);
    expect(afterFirst - before).toBeCloseTo(Number(price), 2);

    // Second completion is refused by the state machine — so the charge can't post twice.
    const second = await transition(page, idempId, 'completed');
    expect(second.status()).toBe(422);
    expect((await second.json()).error.code).toBe('invalid_transition');
    expect((await getBalance(page, client)) - afterFirst).toBeCloseTo(0, 2);
  });
});
