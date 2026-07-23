import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { login, DEMO_ACCOUNTS, openScreen, cleanupUsers, es } from './helpers';

/**
 * ProfessionalsView (roster GenericTable) + ProfessionalDetail. Per the SSoT descriptor,
 * `professionals` grants update to Admin/Receptionist and delete to Admin only; a Professional
 * manages themself through Perfil and is kept off this roster entirely (SCREEN_ACCESS override
 * ['Admin','Receptionist']).
 *
 * The roster row under test is reached by filtering the GenericTable to its unique display_name, not
 * by assuming it lands on page 1. The suite shares one seeded DB that is not reset between local runs,
 * so other specs' throwaway Professionals (and prior runs' residue) can push the roster past a single
 * page — filtering keeps this spec correct regardless of how many Professionals exist.
 *
 * The Professional-denied *route guard* (notPermitted toast + blocked navigation) is generic and
 * covered in P6's routing-guards spec; here we assert the Professional simply has no way into the
 * roster from the UI (the nav link never renders).
 */
const MARGE = 'Dra. Marge Bouvier';

// Narrows the Profesionales GenericTable to rows whose display_name matches `name` via the real
// GenericFilters UI, so the target row is deterministically on page 1 no matter how many other
// Professionals the shared dataset holds.
async function filterByName(page: Page, name: string): Promise<void> {
  await page.getByRole('combobox', { name: es.generic.selectColumnAria }).selectOption('display_name');
  // exact: 'Agregar' is otherwise a substring of the roster's own add-entity button label.
  await page.getByRole('button', { name: es.generic.add, exact: true }).click();
  const resp = page.waitForResponse(
    (r) => r.url().includes('/api/professionals') && r.request().method() === 'GET',
    { timeout: 10_000 },
  );
  await page.getByPlaceholder(es.generic.filterPlaceholder).fill(name);
  await resp;
}

async function openProfessional(page: Page, name: string): Promise<void> {
  await openScreen(page, es.nav.professionals);
  await expect(page.locator('table')).toBeVisible({ timeout: 15_000 });
  await filterByName(page, name);
  await page.getByRole('cell', { name, exact: true }).first().click();
  await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: 10_000 });
}

// The throwaway Professional the deactivate test creates. Its own test soft-deletes it; this is a
// backstop so a failure before that step still doesn't leave a Professional on the roster.
const createdProfIds: number[] = [];

test.afterAll(async ({ browser }) => {
  await cleanupUsers(browser, createdProfIds);
});

test.describe('Professionals roster & detail', () => {
  test('admin opens a professional and sees services, upcoming, and both actions', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await openProfessional(page, MARGE);

    await expect(page.getByRole('heading', { name: es.professionals.servicesHeading })).toBeVisible();
    await expect(page.getByRole('heading', { name: es.portal.upcomingHeading })).toBeVisible();
    // Admin manages any professional: edit-any (update) + deactivate (delete, Admin-only).
    await expect(page.getByRole('button', { name: es.users.editProfile })).toBeVisible();
    await expect(page.getByRole('button', { name: es.users.deactivate })).toBeVisible();
  });

  test('receptionist can edit a professional but cannot deactivate', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.receptionistWithGrant.username, DEMO_ACCOUNTS.receptionistWithGrant.password);
    await openProfessional(page, MARGE);

    await expect(page.getByRole('button', { name: es.users.editProfile })).toBeVisible();
    // delete is Admin-only, so no deactivate affordance for a receptionist.
    await expect(page.getByRole('button', { name: es.users.deactivate })).toHaveCount(0);
  });

  test('a professional has no way into the roster (nav link absent)', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.professionalUser.username, DEMO_ACCOUNTS.professionalUser.password);
    await expect(page).toHaveURL(/\/staff\/dashboard/);
    await expect(page.getByRole('link', { name: es.nav.professionals })).toHaveCount(0);
  });

  test('admin deactivates a professional; empty detail shows no-services/no-upcoming', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    // A throwaway professional (created via the admin endpoint) — collision-free, and freshly created
    // it has no services or turnos, so its detail also exercises both empty states.
    const uniqueName = `E2E Prof ${Date.now()}`;
    const createRes = await page.request.post('/api/admin/users', {
      data: {
        username: `e2e_prof_${Date.now()}`,
        email: `e2e_prof_${Date.now()}@demo.test`,
        password: 'e2e-secure-pass-789',
        role: 'Professional',
        display_name: uniqueName,
      },
    });
    expect(createRes.status()).toBeLessThan(300);
    createdProfIds.push(Number((await createRes.json()).data.id));

    await openProfessional(page, uniqueName);
    await expect(page.getByText(es.professionals.noServicesAssigned)).toBeVisible();
    await expect(page.getByText(es.professionals.noUpcomingBody)).toBeVisible();

    await page.getByRole('button', { name: es.users.deactivate }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: es.professionals.deactivateTitle });
    const deleteResp = page.waitForResponse(
      (r) => /\/api\/professionals\/\d+$/.test(r.url()) && r.request().method() === 'DELETE',
      { timeout: 10_000 },
    );
    await dialog.getByRole('button', { name: es.users.deactivate }).click();
    expect((await deleteResp).ok()).toBe(true);

    // Soft-deleted professionals drop out of the roster read.
    const after = await (await page.request.get(`/api/professionals?filter_display_name=${encodeURIComponent(uniqueName)}`)).json();
    expect((after.data ?? []).length).toBe(0);
  });
});
