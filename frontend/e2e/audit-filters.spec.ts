import { test, expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import { login, DEMO_ACCOUNTS, openScreen, findProfessionalId, cleanupUsers, isoDaysFromNow, es } from './helpers';

/**
 * AuditView — non-admin access, filters (entity/actor/event/date/outcome) + reset, empty, the
 * denied⛔ badge/red row, and pagination. `/staff/audit`'s route meta is Admin-only; the role guard
 * blocks a non-admin (returns false, no redirect) — this spec proves the content stays inaccessible
 * (nav link absent + AuditView never mounts + the server 403s), leaving the generic notPermitted
 * toast mechanics to P6's routing-guards spec.
 *
 * AuditView's own page size is a fixed 50 (not user-controlled), so proving Pagination's
 * `v-if="total > limit"` branch needs a dataset that reliably exceeds 50 — the seeded audit_events
 * total varies by what else has run. Rather than depend on that, this spec self-seeds a single
 * fresh Receptionist and drives 55 denied GET /api/audit calls as that actor in beforeAll: each is a
 * real, deterministic 'permission_denied'/'denied' audit row, isolated to an actor no other spec
 * touches, so filtering by that actor guarantees total === 55 regardless of run order.
 *
 * The entity-type filter is exercised on two values: 'appointments' (always populated by seed
 * activity) and 'calendar_grants' — the latter proves the "Permisos de calendario" option now sends
 * `entity_type=calendar_grants` (matching the literal every grant write stamps) after the AuditView
 * ENTITY_TYPES fix; beforeAll seeds a fresh grant so a matching audit_events row is guaranteed.
 */

const DENIED_COUNT = 55;

// What an element that paints no background of its own computes to.
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

function fromDiv(page: Page): Locator {
  return page.locator('label[for="audit-date-from"]').locator('..');
}
function toDiv(page: Page): Locator {
  return page.locator('label[for="audit-date-to"]').locator('..');
}

async function fillAuditDate(scope: Locator, isoDate: string): Promise<void> {
  const [y, m, d] = isoDate.split('-');
  const input = scope.locator('input[placeholder="dd/mm/aaaa"]').first();
  await input.click();
  await input.fill(`${d}/${m}/${y}`);
  await input.press('Tab');
}

async function openAudit(page: Page): Promise<void> {
  await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
  const listResp = page.waitForResponse((r) => r.url().includes('/api/audit') && r.request().method() === 'GET', { timeout: 15_000 });
  await openScreen(page, es.nav.audit);
  await listResp;
  await expect(page.getByRole('heading', { name: es.audit.title })).toBeVisible();
}

let deniedActorId: number;
let deniedActorUsername: string;

test.beforeAll(async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await login(adminPage, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

  const ts = Date.now();
  deniedActorUsername = `e2e_p5_audit_${ts}`;
  const tempPassword = 'e2e-secure-pass-789';
  const createRes = await adminPage.request.post('/api/admin/users', {
    data: { username: deniedActorUsername, email: `${deniedActorUsername}@demo.test`, password: tempPassword, role: 'Receptionist', display_name: `E2E P5 Audit ${ts}` },
  });
  const createBody = await createRes.json();
  if (!createRes.ok() || !createBody.data?.id) throw new Error(`create audit actor failed: ${createRes.status()} ${JSON.stringify(createBody)}`);
  deniedActorId = Number(createBody.data.id);

  // Seed a real calendar-grant audit event: granting the fresh Receptionist to demo_pro (Marge)
  // writes an audit_events row with entity_type='calendar_grants' (grants.ts), so the
  // "Permisos de calendario" entity filter has a guaranteed match. Fresh grantee → collision-free.
  const margeId = await findProfessionalId(adminPage, 'Marge Bouvier');
  const grantRes = await adminPage.request.post('/api/calendar-grants', {
    data: { professional_user_id: margeId, grantee_user_id: deniedActorId },
  });
  if (!grantRes.ok()) throw new Error(`seed calendar-grant audit event failed: ${grantRes.status()} ${await grantRes.text()}`);
  await adminCtx.close();

  const actorCtx = await browser.newContext();
  const actorPage = await actorCtx.newPage();
  await login(actorPage, deniedActorUsername, tempPassword);
  // Admin-created accounts are must_change_password; clear it first or every call below 403s for
  // the wrong reason (password_change_required, not the permission_denied we want).
  await actorPage.request.post('/api/auth/change-password', {
    data: { current_password: tempPassword, new_password: 'e2e-changed-pass-456' },
  });

  const calls = Array.from({ length: DENIED_COUNT }, () => actorPage.request.get('/api/audit'));
  const results = await Promise.all(calls);
  if (!results.every((r) => r.status() === 403)) throw new Error('expected every self-seed call to be denied with 403');
  await actorCtx.close();
});

// Deactivate the throwaway actor so it stops adding a Receptionist to every roster/user list on
// re-runs. The 55 audit_events rows it produced are append-only and CANNOT be deleted by design —
// they're harmless here because every assertion scopes to this actor (total === 55 by actor
// filter), never to a global audit count, so they never accumulate into a wrong answer.
test.afterAll(async ({ browser }) => {
  await cleanupUsers(browser, [deniedActorId]);
});

test.describe('Audit log (admin) — access, filters, denied styling, pagination', () => {
  test('a non-admin has no nav link and cannot see the audit view', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.receptionistWithGrant.username, DEMO_ACCOUNTS.receptionistWithGrant.password);
    await expect(page.getByRole('link', { name: es.nav.audit })).toHaveCount(0);

    // The role guard blocks staff-audit for non-admins by returning false (navigation aborted, no
    // redirect) and pushing a notPermitted toast — so AuditView never mounts. Assert the content is
    // absent (robust in every end-state), not the URL. The server independently enforces it too.
    await page.goto('/staff/audit');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: es.audit.title })).toHaveCount(0);

    const denied = await page.request.get('/api/audit');
    expect(denied.status()).toBe(403);
  });

  test('entity-type filter narrows to appointments (the value and the stored literal agree)', async ({ page }) => {
    await openAudit(page);
    const resp = page.waitForResponse((r) => r.url().includes('entity_type=appointments') && r.request().method() === 'GET', { timeout: 10_000 });
    await page.getByRole('combobox', { name: es.audit.entityTypeAria }).selectOption('appointments');
    await page.getByRole('button', { name: es.audit.search }).click();
    const body = await (await resp).json();
    expect(body.meta.total).toBeGreaterThan(0);
    await expect(page.locator('tbody tr').first()).toContainText('appointments');
  });

  test('entity-type "Permisos de calendario" filter matches calendar_grants events', async ({ page }) => {
    await openAudit(page);
    // The option now sends entity_type=calendar_grants (the literal every grant write stamps); the
    // grant seeded in beforeAll guarantees a match. A regression to the old `permissions` value would
    // send entity_type=permissions and return zero rows, failing this.
    const resp = page.waitForResponse((r) => r.url().includes('entity_type=calendar_grants') && r.request().method() === 'GET', { timeout: 10_000 });
    await page.getByRole('combobox', { name: es.audit.entityTypeAria }).selectOption('calendar_grants');
    await page.getByRole('button', { name: es.audit.search }).click();
    const body = await (await resp).json();
    expect(body.meta.total).toBeGreaterThan(0);
    await expect(page.locator('tbody tr').first()).toContainText('calendar_grants');
  });

  test('actor + event type + outcome + date range narrow to exactly the self-seeded denied events, styled and paginated', async ({ page }) => {
    await openAudit(page);

    await page.getByPlaceholder(es.audit.actorPlaceholder).fill(deniedActorUsername);
    await page.getByPlaceholder(es.audit.eventTypePlaceholder).fill('permission_denied');
    await page.getByRole('combobox', { name: es.audit.outcome }).selectOption('denied');
    await fillAuditDate(fromDiv(page), isoDaysFromNow(0));
    await fillAuditDate(toDiv(page), isoDaysFromNow(1));

    const resp = page.waitForResponse((r) => r.url().includes('/api/audit') && r.request().method() === 'GET', { timeout: 10_000 });
    await page.getByRole('button', { name: es.audit.search }).click();
    const body = await (await resp).json();
    expect(body.meta.total).toBe(DENIED_COUNT);

    // Every seeded row is denied — the first rendered row carries the ⛔ badge and the denied tint.
    // The tint is asserted as rendered colour, not as a utility-class name: an ordinary row declares
    // no background of its own and inherits the table's, so this still fails if the tint is dropped,
    // while a rename of the underlying design token does not make it a false negative.
    const firstRow = page.locator('tbody tr').first();
    await expect
      .poll(() => firstRow.evaluate((el) => getComputedStyle(el).backgroundColor), { timeout: 10_000 })
      .not.toBe(TRANSPARENT);
    await expect(firstRow.getByText('⛔')).toBeVisible();

    // Pagination: limit is a fixed 50, total 55 → two pages.
    const prevBtn = page.getByRole('button', { name: es.generic.previous });
    const nextBtn = page.getByRole('button', { name: es.generic.next });
    await expect(prevBtn).toBeVisible({ timeout: 10_000 });
    await expect(prevBtn).toBeDisabled();
    await expect(nextBtn).toBeEnabled();

    const page2Resp = page.waitForResponse((r) => r.url().includes('/api/audit') && r.url().includes('page=2'), { timeout: 10_000 });
    await nextBtn.click();
    const page2Body = await (await page2Resp).json();
    expect(page2Body.data.length).toBe(DENIED_COUNT - 50);
    await expect(prevBtn).toBeEnabled();
    await expect(nextBtn).toBeDisabled();
  });

  test('reset clears every filter and reloads unfiltered', async ({ page }) => {
    await openAudit(page);

    await page.getByPlaceholder(es.audit.actorPlaceholder).fill(deniedActorUsername);
    await page.getByRole('combobox', { name: es.audit.outcome }).selectOption('denied');

    const resetResp = page.waitForResponse((r) => r.url().includes('/api/audit') && r.request().method() === 'GET', { timeout: 10_000 });
    await page.getByRole('button', { name: es.audit.clear }).click();
    const url = (await resetResp).url();
    expect(url).not.toContain('actor_username');
    expect(url).not.toContain('outcome=denied');

    await expect(page.getByPlaceholder(es.audit.actorPlaceholder)).toHaveValue('');
  });

  test('a filter combo with no matches shows the empty state', async ({ page }) => {
    await openAudit(page);

    await page.getByPlaceholder(es.audit.actorPlaceholder).fill(deniedActorUsername);
    await page.getByPlaceholder(es.audit.eventTypePlaceholder).fill('e2e_nonexistent_event_type');
    const resp = page.waitForResponse((r) => r.url().includes('/api/audit') && r.request().method() === 'GET', { timeout: 10_000 });
    await page.getByRole('button', { name: es.audit.search }).click();
    await resp;

    await expect(page.getByRole('heading', { name: es.audit.emptyHeading })).toBeVisible({ timeout: 10_000 });
  });
});
