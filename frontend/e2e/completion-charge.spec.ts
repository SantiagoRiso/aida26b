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
 * idempotent `charge` for the frozen price. The charge and no-charge outcomes are covered through
 * the dashboard settle flow; this API-level case keeps the distinct state-machine guarantee that
 * a completed turno cannot be completed or charged twice.
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

test.describe('Completion is not double-charged', () => {
  let idempId: number;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const admin = await ctx.newPage();
    await login(admin, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    const professional_user_id = await findProfessionalId(admin, 'Dr. Julius Hibbert');
    const service_id = await findServiceId(admin, SERVICE);
    const agnes = await findClientId(admin, 'Agnes Skinner');

    const base = { professional_user_id, service_id, duration_minutes: DURATION, date: PAST };
    idempId    = await scheduleViaApi(admin, { ...base, client_user_id: agnes, start: '09:30', name: 'E2E idempotente' });
    await ctx.close();
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
