import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { login, DEMO_ACCOUNTS, openScreen, clientSearchBox, es } from './helpers';

/**
 * ResourcesSection (Salas) — add, inline edit, delete via the row-level "Eliminar" testid button,
 * and "Horario" opening the resource's ScheduleBlockEditor. `staff-crud.spec.ts` already deletes a
 * *seeded* room (Consultorio 5) through this exact same row-level Eliminar → ConfirmDialog → DELETE
 * path — verified against the current component, that case already drives the real model (an
 * always-visible inline Eliminar, not the stale "click the row text for a DetailPanel" model the
 * coverage plan flagged), so it's left as-is; this spec adds the states staff-crud doesn't cover.
 *
 * Rooms here are fresh (`Sala E2E P5 <suffix>`), never the seeded "Consultorio N" rows — the
 * dataset always has the seeded Consultorios, so a literal "zero rooms" empty state isn't reachable
 * in this shared business (see report: that state is a component-test concern per the coverage
 * plan's own tier rule, not an e2e one).
 *
 * NOTE — the generic create validator (validateFullObject) requires every editable column's KEY to
 * be present even when nullable, so `description` must be sent (as null or a string). The Salas UI's
 * `saveAdd` sends `{ name, description: null }` accordingly; the "adding a room" test drives that
 * real inline create end-to-end so a regression to a name-only payload (the old 400 bug) fails here.
 */

async function createRoom(req: APIRequestContext, name: string): Promise<number> {
  const res = await req.post('/api/resources', { data: { name, description: null } });
  const body = await res.json();
  if (!res.ok() || !body.data?.id) throw new Error(`create resource failed: ${res.status()} ${JSON.stringify(body)}`);
  return Number(body.data.id);
}

const ts = Date.now();

test.describe('Resources (Salas) — add, inline edit, delete, Horario', () => {
  test('adding a room requires a name, then creates it through the inline UI', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await openScreen(page, es.nav.business);

    // The name-required guard is client-side (saveAdd early-returns before any request).
    await page.getByTestId('room-add-start').click();
    await page.getByTestId('room-add-save').click();
    await expect(page.getByText(es.resources.nameRequired)).toBeVisible({ timeout: 10_000 });

    // Drive the real inline create end-to-end: saveAdd must send the required `description` key
    // (regression to a name-only payload → 400 fails this).
    const name = `Sala E2E P5 ${ts} Add`;
    await page.getByTestId('room-add-name').fill(name);
    const createResp = page.waitForResponse((r) => r.url().endsWith('/api/resources') && r.request().method() === 'POST', { timeout: 10_000 });
    await page.getByTestId('room-add-save').click();
    expect((await createResp).status()).toBeLessThan(300);

    await expect(page.getByText(name)).toBeVisible({ timeout: 10_000 });
  });

  test('inline edit blocks an empty name, then saves name and description', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    const roomId = await createRoom(page.request, `Sala E2E P5 ${ts} Edit`);

    await openScreen(page, es.nav.business);
    const row = page.getByTestId(`room-row-${roomId}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByTestId(`room-edit-${roomId}`).click();

    await row.getByTestId(`room-edit-name-${roomId}`).fill('');
    await row.getByTestId(`room-edit-save-${roomId}`).click();
    await expect(row.getByText(es.resources.nameRequired)).toBeVisible();

    const newName = `Sala E2E P5 ${ts} Edited`;
    const newDescription = `Descripción E2E ${ts}`;
    await row.getByTestId(`room-edit-name-${roomId}`).fill(newName);
    await row.getByTestId(`room-edit-description-${roomId}`).fill(newDescription);
    const updateResp = page.waitForResponse((r) => r.url().includes(`/api/resources/${roomId}`) && r.request().method() === 'PUT', { timeout: 10_000 });
    await row.getByTestId(`room-edit-save-${roomId}`).click();
    expect((await updateResp).ok()).toBe(true);

    await expect(row.getByText(newName)).toBeVisible({ timeout: 10_000 });
    await expect(row.getByText(newDescription)).toBeVisible();

    // Durable: a fresh mount still reflects the edit.
    await page.reload();
    const reloadedRow = page.getByTestId(`room-row-${roomId}`);
    await expect(reloadedRow).toBeVisible({ timeout: 15_000 });
    await expect(reloadedRow.getByText(newName)).toBeVisible();
  });

  test('deleting a room via the row-level Eliminar button confirms then removes it, durably', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    const name = `Sala E2E P5 ${ts} Delete`;
    const roomId = await createRoom(page.request, name);

    await openScreen(page, es.nav.business);
    const row = page.getByTestId(`room-row-${roomId}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByTestId(`room-delete-${roomId}`).click();

    const dialog = page.getByRole('dialog').filter({ hasText: es.resources.deleteTitle });
    const deleteResp = page.waitForResponse((r) => r.url().includes(`/api/resources/${roomId}`) && r.request().method() === 'DELETE', { timeout: 10_000 });
    await dialog.getByRole('button', { name: es.actions.delete }).click();
    expect((await deleteResp).ok()).toBe(true);

    await expect(page.getByTestId(`room-row-${roomId}`)).toHaveCount(0, { timeout: 10_000 });

    // Durable: remount the section (navigate away and back) and confirm it stays gone (soft delete).
    await page.getByRole('link', { name: es.nav.clients }).click();
    await expect(clientSearchBox(page)).toBeVisible({ timeout: 15_000 });
    await openScreen(page, es.nav.business);
    await expect(page.getByTestId(`room-row-${roomId}`)).toHaveCount(0);
  });

  test('"Horario" opens the resource schedule editor in a detail panel', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    const name = `Sala E2E P5 ${ts} Schedule`;
    const roomId = await createRoom(page.request, name);

    await openScreen(page, es.nav.business);
    const row = page.getByTestId(`room-row-${roomId}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByTestId(`room-schedule-${roomId}`).click();

    await expect(page.getByRole('heading', { name: es.resources.scheduleTitle })).toBeVisible({ timeout: 10_000 });
    // ScheduleBlockEditor mounted for this resource — its weekly calendar renders inside the panel.
    await expect(page.locator('.fc')).toBeVisible({ timeout: 10_000 });
  });
});
