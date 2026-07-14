import { test, expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import { login, DEMO_ACCOUNTS, openScreen, fillDate, isoDaysFromNow, es } from './helpers';

/**
 * BusinessClosuresSection add/edit/delete, on dates that carry NO booked turno — the conflict-gate
 * confirm (adding/editing a closure that overlaps a booked turno) is already covered end-to-end in
 * `timeoff-conflict-gate.spec.ts`; duplicating it here would just re-test useTimeOffConflictGate.
 * Dates isoDaysFromNow(64)..(72) are this spec's alone (see e2e-coverage-plan.md P5 fixture partition)
 * and clear of any seeded/other-spec turno, so `confirmClosure` always resolves truthy without a
 * dialog ever appearing.
 *
 * TimeField instances here carry no `id` (the template passes none), so — unlike `fillTime` in
 * helpers.ts, which needs one — this spec drives them with a scoped `.fill()` on the masked input
 * directly; the component's onInput handler reformats a whole pasted digit string in one pass, so a
 * single fill (not the click-and-adjust dance) is sufficient for a field that starts blank.
 */

const closuresSection = (page: Page) =>
  page.locator('section').filter({ has: page.getByTestId('closure-add-submit') });

async function fillClosureTime(scope: Locator, labelText: string, hhmm: string): Promise<void> {
  const input = scope.locator('label').filter({ hasText: labelText }).locator('input[inputmode="numeric"]');
  await input.fill(hhmm.replace(':', ''));
  await input.blur();
  await expect(input).toHaveValue(hhmm, { timeout: 5_000 });
}

const DATES = {
  allDay: isoDaysFromNow(64),
  partial: isoDaysFromNow(65),
  edited: isoDaysFromNow(66),
  deleted: isoDaysFromNow(67),
  partialInvalid: isoDaysFromNow(68),
};

test.describe('Business closures — add / edit / delete (no conflict)', () => {
  test('date is required before adding', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await openScreen(page, es.nav.business);
    const section = closuresSection(page);
    await expect(section.getByTestId('closure-add-submit')).toBeVisible({ timeout: 15_000 });

    await section.getByTestId('closure-add-submit').click();
    await expect(section.getByText(es.closures.selectDate)).toBeVisible();
  });

  test('a partial (non all-day) closure requires both start and end', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await openScreen(page, es.nav.business);
    const section = closuresSection(page);
    await expect(section.getByTestId('closure-add-submit')).toBeVisible({ timeout: 15_000 });

    await fillDate(section, DATES.partialInvalid);
    await section.getByTestId('closure-add-allday').uncheck();
    await section.getByTestId('closure-add-submit').click();
    await expect(section.getByText(es.closures.fillRange)).toBeVisible();

    // Nothing was persisted for this date.
    const closures = await (await page.request.get('/api/business-closures')).json();
    expect((closures.data ?? []).some((c: { exception_date: string }) => c.exception_date === DATES.partialInvalid)).toBe(false);
  });

  test('adds an all-day closure, shown with the "Todo el día" range label', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await openScreen(page, es.nav.business);
    const section = closuresSection(page);
    await expect(section.getByTestId('closure-add-submit')).toBeVisible({ timeout: 15_000 });

    await fillDate(section, DATES.allDay);
    // allDay defaults to checked — no time range to fill.
    const postResp = page.waitForResponse((r) => r.url().includes('/business-closures') && r.request().method() === 'POST', { timeout: 10_000 });
    await section.getByTestId('closure-add-submit').click();
    expect((await postResp).ok()).toBe(true);
    await expect(page.getByText(es.toast.saved)).toBeVisible({ timeout: 5_000 });

    const row = page.locator('li').filter({ hasText: DATES.allDay });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row).toContainText(es.closures.allDay);
  });

  test('adds a partial-range closure, shown with an HH:MM–HH:MM range label', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await openScreen(page, es.nav.business);
    const section = closuresSection(page);
    await expect(section.getByTestId('closure-add-submit')).toBeVisible({ timeout: 15_000 });

    await fillDate(section, DATES.partial);
    await section.getByTestId('closure-add-allday').uncheck();
    await fillClosureTime(section, es.generic.from, '09:00');
    await fillClosureTime(section, es.generic.to, '12:00');

    const postResp = page.waitForResponse((r) => r.url().includes('/business-closures') && r.request().method() === 'POST', { timeout: 10_000 });
    await section.getByTestId('closure-add-submit').click();
    expect((await postResp).ok()).toBe(true);

    const row = page.locator('li').filter({ hasText: DATES.partial });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row).toContainText('09:00');
    await expect(row).toContainText('12:00');
    await expect(row).not.toContainText(es.closures.allDay);
  });

  test('inline edit switches an all-day closure to a partial range and updates its reason', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await openScreen(page, es.nav.business);
    const section = closuresSection(page);
    await expect(section.getByTestId('closure-add-submit')).toBeVisible({ timeout: 15_000 });

    // Seed: an all-day closure to edit.
    await fillDate(section, DATES.edited);
    const createResp = page.waitForResponse((r) => r.url().includes('/business-closures') && r.request().method() === 'POST', { timeout: 10_000 });
    await section.getByTestId('closure-add-submit').click();
    await createResp;

    const row = page.locator('li').filter({ hasText: DATES.edited });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByRole('button', { name: es.actions.edit }).click();

    // Editing swaps the row's display text (the ISO date) for a DateField showing dd/mm/yyyy, so the
    // original `row` locator (matched by that ISO text) stops resolving once edit mode renders. Only
    // one row is ever mid-edit at a time, so the edit-only testid re-anchors to the same <li>.
    const editingRow = page.locator('li').filter({ has: page.getByTestId('closure-edit-allday') });
    await editingRow.getByTestId('closure-edit-allday').uncheck();
    await fillClosureTime(editingRow, es.generic.from, '14:00');
    await fillClosureTime(editingRow, es.generic.to, '16:30');
    const reason = `E2E edited ${Date.now()}`;
    await editingRow.locator('label').filter({ hasText: es.fields.reasonOptional }).locator('input').fill(reason);

    const putResp = page.waitForResponse((r) => /\/business-closures\/[^/]+$/.test(r.url()) && r.request().method() === 'PUT', { timeout: 10_000 });
    await editingRow.getByRole('button', { name: es.actions.saveChanges }).click();
    expect((await putResp).ok()).toBe(true);

    // Saving exits edit mode, restoring the ISO-date text — `row` resolves again.
    await expect(row).toContainText('14:00');
    await expect(row).toContainText('16:30');
    await expect(row).toContainText(reason);
    await expect(row).not.toContainText(es.closures.allDay);
  });

  test('delete confirms then removes the closure, durably', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await openScreen(page, es.nav.business);
    const section = closuresSection(page);
    await expect(section.getByTestId('closure-add-submit')).toBeVisible({ timeout: 15_000 });

    await fillDate(section, DATES.deleted);
    const createResp = page.waitForResponse((r) => r.url().includes('/business-closures') && r.request().method() === 'POST', { timeout: 10_000 });
    await section.getByTestId('closure-add-submit').click();
    await createResp;

    const row = page.locator('li').filter({ hasText: DATES.deleted });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByRole('button', { name: es.closures.remove }).click();

    const dialog = page.getByRole('dialog').filter({ hasText: es.closures.removeBody });
    const deleteResp = page.waitForResponse((r) => /\/business-closures\/[^/]+$/.test(r.url()) && r.request().method() === 'DELETE', { timeout: 10_000 });
    await dialog.getByRole('button', { name: es.closures.remove }).click();
    expect((await deleteResp).ok()).toBe(true);

    await expect(page.locator('li').filter({ hasText: DATES.deleted })).toHaveCount(0, { timeout: 10_000 });

    const closures = await (await page.request.get('/api/business-closures')).json();
    expect((closures.data ?? []).some((c: { exception_date: string }) => c.exception_date === DATES.deleted)).toBe(false);
  });
});
