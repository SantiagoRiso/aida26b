import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  login,
  DEMO_ACCOUNTS,
  openScreen,
  openAppointmentDetail,
  fillDate,
  findProfessionalId,
  findClientId,
  findServiceId,
  scheduleViaApi,
  es,
} from './helpers';
import { DEMO_SERVICE_NAMES, shiftSeedDate } from '../../shared/src/dev-fixtures';

/**
 * The warn-then-confirm time-off gate (useTimeOffConflictGate): adding a business closure that
 * overlaps open, future turnos surfaces a ConfirmDialog first. Confirming flags those turnos
 * in_conflict (computed, reversible); cancelling aborts the whole save. Staff can then acknowledge
 * ('Ignorar conflicto') or re-flag ('Reactivar aviso') a conflicting turno from its detail panel.
 *
 * Each test self-seeds its own turno on Dra. Marge Bouvier (demo_pro) via the staff schedule API
 * (override → a sobreturno lands regardless of her grid) and creates an all-day business closure
 * on the same date through Admin → Negocio → Días festivos. Dates are shifted onto the current week
 * (shiftSeedDate) so they land past the seed's dense-fill window and clear of other specs' dates,
 * so the only turno the closure hits on that date is this test's own — the confirm copy and flag
 * are deterministic.
 */

const MARGE = 'Marge Bouvier';

// A no-relation-to-Marge client per test (distinct so the seeded turnos never collide).
const FIXTURES = {
  flag:   { date: shiftSeedDate('2026-09-01'), client: 'Ruth Powers' },
  cancel: { date: shiftSeedDate('2026-09-02'), client: 'Luann Van Houten' },
  ignore: { date: shiftSeedDate('2026-09-03'), client: 'Agnes Skinner' },
} as const;

// Seeds a scheduled turno on Marge at 10:00. Admin-authed page required.
async function seedTurno(page: Page, date: string, clientName: string): Promise<{ apptId: number; professionalId: number }> {
  const professionalId = await findProfessionalId(page, MARGE);
  const clientId = await findClientId(page, clientName);
  const serviceId = await findServiceId(page, DEMO_SERVICE_NAMES.sesion);
  const apptId = await scheduleViaApi(page, {
    professional_user_id: professionalId,
    service_id: serviceId,
    client_user_id: clientId,
    date,
    start: '10:00',
    duration_minutes: 50,
    name: 'e2e conflict-gate fixture',
  });
  return { apptId, professionalId };
}

// Whether the turno appears in Marge's server-computed conflicting list (the in_conflict flag).
// The GET /:id detail returns a.* only (no computed in_conflict), so membership in the
// conflicting=true list is the authoritative read of the flag.
async function isFlagged(page: Page, professionalId: number, apptId: number): Promise<boolean> {
  const res = await page.request.get(`/api/appointments?professional_user_id=${professionalId}&conflicting=true&limit=500`);
  const body = await res.json();
  return (body.data ?? []).some((r: { id: string | number }) => Number(r.id) === apptId);
}

// The stored conflict_ignored bit, read back from the detail endpoint (a real column).
async function conflictIgnored(page: Page, apptId: number): Promise<boolean> {
  const res = await page.request.get(`/api/appointments/${apptId}`);
  const body = await res.json();
  return body.data.conflict_ignored === true;
}

// Fills the all-day closure add form for `date` and clicks Agregar día festivo. Because the seeded
// turno overlaps, the gate previews a conflict and opens its ConfirmDialog — returned for the
// caller to confirm or cancel. Scoped to the Días festivos section so its DateField is unambiguous.
async function openClosureGate(page: Page, date: string) {
  await openScreen(page, es.nav.business);
  const section = page.locator('section').filter({ has: page.getByTestId('closure-add-submit') });
  await expect(section.getByTestId('closure-add-submit')).toBeVisible();
  await fillDate(section, date);
  await page.getByTestId('closure-add-submit').click();

  // The gate is the headlessui confirm dialog carrying the conflict copy. Scope to it by that copy —
  // the VueDatePicker keeps its own role=dialog menu in the DOM through its close transition, so a
  // bare getByRole('dialog') matches two elements right after fillDate. Wait on the confirm button
  // rather than the dialog div: that div only wraps position:fixed children, so it has a zero-height
  // box and reads as "hidden" even while open (every dialog spec here interacts with its contents).
  const dialog = page.getByRole('dialog').filter({ hasText: 'en conflicto' });
  await expect(dialog.getByRole('button', { name: es.actions.continue })).toBeVisible({ timeout: 10_000 });
  return dialog;
}

test.describe('Time-off conflict gate — business closure over a booked turno', () => {
  test('confirming the gate flags the overlapping turno in_conflict', async ({ page }) => {
    const { date, client } = FIXTURES.flag;
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    const { apptId, professionalId } = await seedTurno(page, date, client);
    expect(await isFlagged(page, professionalId, apptId)).toBe(false);

    const dialog = await openClosureGate(page, date);
    const postResp = page.waitForResponse(
      (r) => r.url().includes('/business-closures') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await dialog.getByRole('button', { name: es.actions.continue }).click();
    expect((await postResp).ok()).toBe(true);

    // Closure persisted…
    const closures = await (await page.request.get('/api/business-closures')).json();
    expect((closures.data ?? []).some((c: { exception_date: string }) => c.exception_date === date)).toBe(true);
    // …and the overlapping turno is now flagged.
    expect(await isFlagged(page, professionalId, apptId)).toBe(true);
  });

  test('cancelling the gate aborts the save and leaves the turno unflagged', async ({ page }) => {
    const { date, client } = FIXTURES.cancel;
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    const { apptId, professionalId } = await seedTurno(page, date, client);

    const dialog = await openClosureGate(page, date);
    await dialog.getByRole('button', { name: es.actions.cancel }).click();
    // Assert on the button, not the dialog div (that wrapper reads "hidden" even while open).
    await expect(dialog.getByRole('button', { name: es.actions.continue })).toBeHidden();

    // No closure was written and the turno was never flagged.
    const closures = await (await page.request.get('/api/business-closures')).json();
    expect((closures.data ?? []).some((c: { exception_date: string }) => c.exception_date === date)).toBe(false);
    expect(await isFlagged(page, professionalId, apptId)).toBe(false);
  });

  test('detail panel acknowledges and re-flags a conflicting turno', async ({ page }) => {
    const { date, client } = FIXTURES.ignore;
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    const { apptId, professionalId } = await seedTurno(page, date, client);

    // Flag it via the same gate mechanism.
    const dialog = await openClosureGate(page, date);
    const postResp = page.waitForResponse(
      (r) => r.url().includes('/business-closures') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await dialog.getByRole('button', { name: es.actions.continue }).click();
    expect((await postResp).ok()).toBe(true);
    expect(await isFlagged(page, professionalId, apptId)).toBe(true);

    // Open its calendar detail panel — badge + Ignorar conflicto are staff-only, shown while flagged.
    await openAppointmentDetail(page, apptId);
    await expect(page.getByText(es.calendar.inConflictBadge, { exact: true })).toBeVisible();
    const ignoreBtn = page.getByRole('button', { name: es.calendar.ignoreConflict });
    await expect(ignoreBtn).toBeVisible();

    // Acknowledge → conflict_ignored stored true; the flag clears.
    const ignoreResp = page.waitForResponse(
      (r) => r.url().includes(`/appointments/${apptId}/ignore-conflict`) && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await ignoreBtn.click();
    expect((await ignoreResp).ok()).toBe(true);
    expect(await conflictIgnored(page, apptId)).toBe(true);
    expect(await isFlagged(page, professionalId, apptId)).toBe(false);

    // The panel now offers Reactivar aviso; re-flagging restores the conflict.
    const reflagBtn = page.getByRole('button', { name: es.calendar.reflagConflict });
    await expect(reflagBtn).toBeVisible();
    const reflagResp = page.waitForResponse(
      (r) => r.url().includes(`/appointments/${apptId}/ignore-conflict`) && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await reflagBtn.click();
    expect((await reflagResp).ok()).toBe(true);
    expect(await conflictIgnored(page, apptId)).toBe(false);
    expect(await isFlagged(page, professionalId, apptId)).toBe(true);
  });
});
