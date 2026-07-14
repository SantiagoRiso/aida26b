import { test, expect } from '@playwright/test';
import type { Page, APIRequestContext } from '@playwright/test';
import {
  login,
  DEMO_ACCOUNTS,
  findProfessionalId,
  findServiceId,
  requestViaApi,
  isoDaysFromNow,
  es,
} from './helpers';
import { DEMO_SERVICE_NAMES, DEMO_PASSWORD } from '../../shared/src/dev-fixtures';

/**
 * RequestsView — the staff triage of client-submitted 'requested' turnos: list, the detail drawer
 * (client profile, balance banner, history stats, read-only day calendar), and the Approve / Reject
 * actions. The seed already plants several requests, so each test self-seeds its OWN request from a
 * freshly-created, uniquely-named client — that name is the row's stable locator, independent of the
 * seeded rows. Requests must come from the client themselves, so those clients are login-enabled.
 * All UI strings come from the `es` SSoT.
 */
const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

async function createLoginClient(req: APIRequestContext, username: string, displayName: string): Promise<void> {
  const res = await req.post('/api/admin/users', {
    data: { role: 'Client', username, email: `${username}@demo.test`, password: DEMO_PASSWORD, display_name: displayName },
  });
  if (!res.ok()) throw new Error(`create login client failed: ${res.status()} ${await res.text()}`);
}

// First date with >= 2 free sesión slots for Marge. Requests (unlike the override schedule API) are
// bound by the booking window, so we scan now+N days: offsets past the seed's dense fill (~37) yet
// in-window return an `open` day with free slots; out-of-window / closed / fully-booked days report
// no slots and are skipped. Weekday variation across the scan finds one of Marge's working days.
async function findMargeSlots(page: Page, margeId: number, sesionId: number): Promise<{ date: string; slots: { start: string; end: string }[] }> {
  for (let n = 37; n <= 60; n++) {
    const date = isoDaysFromNow(n);
    const res = await page.request.get(`/api/availability?owner=prof:${margeId}&date=${date}&service=${sesionId}`);
    const body = await res.json();
    if (body.data?.open && (body.data.slots ?? []).length >= 2) return { date, slots: body.data.slots };
  }
  throw new Error('no in-window date with >=2 free Marge slots found');
}

let clientAName: string;
let clientBName: string;
let requestAId: number;
let requestBId: number;

test.beforeAll(async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const ap = await adminCtx.newPage();
  await login(ap, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

  const [margeId, sesionId] = await Promise.all([
    findProfessionalId(ap, 'Marge Bouvier'),
    findServiceId(ap, DEMO_SERVICE_NAMES.sesion),
  ]);

  const ts = Date.now();
  clientAName = `E2E ReqA ${ts}`;
  clientBName = `E2E ReqB ${ts}`;
  const aUser = `e2e_reqa_${ts}`;
  const bUser = `e2e_reqb_${ts}`;
  await createLoginClient(ap.request, aUser, clientAName);
  await createLoginClient(ap.request, bUser, clientBName);

  const { date, slots } = await findMargeSlots(ap, margeId, sesionId);
  const reqFor = async (username: string, slot: { start: string; end: string }): Promise<number> => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await login(p, username, DEMO_PASSWORD);
    // Admin-created accounts are flagged must_change_password, which 403s every other route until
    // cleared — so complete the change first (login still set the session cookie).
    await p.request.post('/api/auth/change-password', {
      data: { current_password: DEMO_PASSWORD, new_password: 'e2e-changed-pass-123' },
    });
    const id = await requestViaApi(p, {
      professional_user_id: margeId,
      service_id: sesionId,
      date,
      start: slot.start,
      duration_minutes: toMin(slot.end) - toMin(slot.start),
    });
    await ctx.close();
    return id;
  };
  requestAId = await reqFor(aUser, slots[0]);
  requestBId = await reqFor(bUser, slots[1]);

  await adminCtx.close();
});

async function openRequests(page: Page): Promise<void> {
  await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
  await page.getByRole('link', { name: es.nav.requests }).click();
  await expect(page.getByRole('heading', { name: es.nav.requests })).toBeVisible({ timeout: 15_000 });
}

async function apptState(page: Page, id: number): Promise<string> {
  const res = await page.request.get(`/api/appointments/${id}`);
  return (await res.json()).data.state;
}

test.describe('Requests triage — list, detail drawer, approve & reject', () => {
  test('opening a request shows the detail drawer with client, balance, and day schedule', async ({ page }) => {
    await openRequests(page);
    const row = page.locator('li').filter({ hasText: clientAName });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();

    // Drawer sections (all drawer-specific copy from the SSoT). `exact` on requestHeading ('Solicitud')
    // avoids matching the panel title 'Detalle de la solicitud' as a substring.
    await expect(page.getByRole('heading', { name: es.requests.requestHeading, exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(es.requests.balanceDebt)).toBeVisible();
    await expect(page.getByRole('heading', { name: es.requests.daySchedule })).toBeVisible();
  });

  test('approving a request schedules it and drops it from the list', async ({ page }) => {
    await openRequests(page);
    const row = page.locator('li').filter({ hasText: clientAName });
    await expect(row).toBeVisible({ timeout: 10_000 });

    const approveResp = page.waitForResponse(
      (r) => /\/appointments\/\d+\/approve/.test(r.url()) && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await row.getByRole('button', { name: es.calendar.approve }).click();
    expect((await approveResp).ok()).toBe(true);

    expect(await apptState(page, requestAId)).toBe('scheduled');
    await expect(page.locator('li').filter({ hasText: clientAName })).toHaveCount(0, { timeout: 10_000 });
  });

  test('rejecting a request confirms then marks it rejected', async ({ page }) => {
    await openRequests(page);
    const row = page.locator('li').filter({ hasText: clientBName });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByRole('button', { name: es.calendar.reject }).click();

    const dialog = page.getByRole('dialog').filter({ hasText: es.requests.rejectBody });
    const rejectResp = page.waitForResponse(
      (r) => /\/appointments\/\d+\/transition/.test(r.url()) && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await dialog.getByRole('button', { name: es.calendar.reject }).click();
    expect((await rejectResp).ok()).toBe(true);

    expect(await apptState(page, requestBId)).toBe('rejected');
  });
});
