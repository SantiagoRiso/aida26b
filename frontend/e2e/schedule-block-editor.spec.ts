import { test, expect } from '@playwright/test';
import type { Page, Locator, APIRequestContext } from '@playwright/test';
import { login, DEMO_ACCOUNTS, findProfessionalId, es } from './helpers';

/**
 * ScheduleEditorView / ScheduleBlockEditor / BlockEditorModal — the weekly template grid.
 *
 * Scope note: the drag-to-create / overlap / invalid-range paths run through decideCreate/decideUpdate,
 * which are exhaustively unit-tested at the component level in `test/schedule-block-editor.test.ts`
 * (the exposed FullCalendar handlers are invoked directly there). FullCalendar's raw drag gesture is
 * unreliable under Playwright in this repo — the same reason calendar-reschedule.spec.ts and
 * sobreturno-toggle.spec.ts avoid it — so this spec does NOT drive a mouse drag. It covers what the
 * unit tests can't: the no-professional prompt, and the modal / confirm-dialog UI wiring (edit block
 * times, delete with confirm) against the real backend.
 *
 * The template calendar is a fixed, dateless week anchored at TEMPLATE_BASE_MONDAY (2024-01-01), so
 * mon..sun map to 2024-01-01..07 regardless of when this spec runs (scheduleTemplateGrid.ts).
 *
 * Fixture: Dr. Nick Riviera (this phase's exclusive professional, seeded Mon-Thu kinesiología blocks).
 * The edit/delete cases operate on blocks this spec self-seeds on his otherwise-free Sat/Sun so they
 * never collide with the seeded weekday blocks and are re-run safe (a fresh block per run).
 */
interface ScheduleBlockRow {
  id: string;
  professional_user_id: string;
  weekday: string;
  start_time: string;
  end_time: string;
}

async function seedBlock(
  req: APIRequestContext,
  professionalId: number,
  weekday: string,
  startTime: string,
  endTime: string,
): Promise<string> {
  // Generic create is full-object: every editable column must be present (resource_id null for a
  // professional-owned block). Path is the generic collection POST — /api/schedule_blocks.
  const res = await req.post('/api/schedule_blocks', {
    data: {
      professional_user_id: String(professionalId),
      resource_id: null,
      weekday,
      start_time: startTime,
      end_time: endTime,
    },
  });
  const body = await res.json();
  if (!res.ok() || !body.data?.id) throw new Error(`seed block failed: ${res.status()} ${JSON.stringify(body)}`);
  return String(body.data.id);
}

async function openScheduleEditor(page: Page): Promise<void> {
  await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
  await page.getByRole('link', { name: es.nav.schedule }).click();
  await expect(page.getByRole('heading', { name: es.schedule.title })).toBeVisible({ timeout: 15_000 });
}

async function pickProfessional(page: Page, displayName: string): Promise<void> {
  // ProfessionalPicker renders a native <select> here (not searchable) once more than one
  // professional is visible to Admin.
  await page.locator('#schedule-professional-select').selectOption({ label: displayName });
  await expect(page.locator('.fc')).toBeVisible({ timeout: 10_000 });
}

async function blocksFor(page: Page, professionalId: number): Promise<ScheduleBlockRow[]> {
  const res = await page.request.get(`/api/schedule_blocks?filter_professional_user_id=${professionalId}&limit=200`);
  const body = await res.json();
  return (body.data ?? []) as ScheduleBlockRow[];
}

// GET-by-id is not a route (only the collection GET is; PUT/DELETE take the :id path). Read a single
// block by filtering the list and matching its id.
async function blockById(page: Page, professionalId: number, id: string): Promise<ScheduleBlockRow | undefined> {
  return (await blocksFor(page, professionalId)).find((b) => b.id === id);
}

let nickId: number;
let editBlockId: string;
let deleteBlockId: string;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
  nickId = await findProfessionalId(page, 'Dr. Nick Riviera');
  // Sat/Sun are free for Nick (seed is Mon-Thu), so these self-seeded blocks never overlap the
  // seeded weekday blocks; a wide 10:00-13:00 span leaves room to bump the start without hitting end.
  [editBlockId, deleteBlockId] = await Promise.all([
    seedBlock(page.request, nickId, 'sat', '10:00', '13:00'),
    seedBlock(page.request, nickId, 'sun', '10:00', '13:00'),
  ]);
  await context.close();
});

test.describe('ScheduleEditorView — no professional selected', () => {
  test('shows the prompt and no calendar until a professional is picked', async ({ page }) => {
    await openScheduleEditor(page);
    await expect(page.getByText(es.schedule.noProfessional)).toBeVisible();
    await expect(page.locator('.fc')).toHaveCount(0);
  });
});

test.describe('ScheduleEditorView — edit and delete an existing block', () => {
  async function openBlockEditor(page: Page, blockId: string): Promise<Locator> {
    await page.locator(`[data-block-id="${blockId}"]`).first().click();
    const modal = page.locator('[data-testid="block-editor-modal"]');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    return modal;
  }

  test('editing a block\'s start time via the modal persists it', async ({ page }) => {
    await openScheduleEditor(page);
    await pickProfessional(page, 'Dr. Nick Riviera');

    const before = await blockById(page, nickId, editBlockId);
    expect(before, 'self-seeded Saturday block must be present').toBeTruthy();
    const startHour = Number(before!.start_time.slice(0, 2));
    const expectedStart = `${String(startHour + 1).padStart(2, '0')}:00`; // one hourUp click

    const modal = await openBlockEditor(page, editBlockId);
    const startInput = modal.locator('input[inputmode="numeric"]').first();
    await startInput.click(); // opens the hour/minute adjuster popover
    await modal.getByRole('button', { name: es.timeField.hourUp }).click();
    // Confirm the hourUp registered on the field before submitting.
    await expect(startInput).toHaveValue(expectedStart, { timeout: 5_000 });
    // Dismiss the TimeField popover by moving focus to a neutral spot in the modal — NOT Escape,
    // which the headlessui Dialog treats as close-the-whole-modal (the save button would vanish).
    // Clicking the title blurs the field, closing the popover via its focusout handler.
    await modal.getByText(es.schedule.editBlock).click();

    const saveResponse = page.waitForResponse(
      (r) => new RegExp(`/api/schedule_blocks/${editBlockId}$`).test(r.url()) && r.request().method() === 'PUT',
      { timeout: 10_000 },
    );
    await modal.getByTestId('block-edit-save').click();
    const resp = await saveResponse;
    expect(resp.ok()).toBe(true);
    await expect(modal).toHaveCount(0);

    const after = await blockById(page, nickId, editBlockId);
    expect(after!.start_time.startsWith(expectedStart)).toBe(true);
  });

  test('deleting a block via the confirm dialog removes it', async ({ page }) => {
    await openScheduleEditor(page);
    await pickProfessional(page, 'Dr. Nick Riviera');

    expect(await blockById(page, nickId, deleteBlockId), 'self-seeded Sunday block must be present').toBeTruthy();

    const modal = await openBlockEditor(page, deleteBlockId);
    await modal.getByTestId('block-edit-delete').click();
    await expect(modal).toHaveCount(0); // the editor closes before the confirm dialog opens

    const confirmDialog = page.getByRole('dialog').filter({ hasText: es.schedule.deleteConfirm });
    const deleteResponse = page.waitForResponse(
      (r) => new RegExp(`/api/schedule_blocks/${deleteBlockId}$`).test(r.url()) && r.request().method() === 'DELETE',
      { timeout: 10_000 },
    );
    await confirmDialog.getByRole('button', { name: es.actions.confirm }).click();
    const resp = await deleteResponse;
    expect(resp.ok()).toBe(true);

    expect(await blockById(page, nickId, deleteBlockId)).toBeUndefined();
  });
});
