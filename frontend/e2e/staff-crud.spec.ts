import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { login, DEMO_ACCOUNTS } from './helpers';

// Drives GenericFilters to locate a row that isn't necessarily on page 1 — the
// 'clients'/'users' tables have 30+ seeded rows sorted by id, so a freshly created or
// specifically-named row can land on a later page. Filtering is more reliable than paging.
async function filterTableBy(page: Page, columnLabel: string, value: string): Promise<void> {
  await page.locator('select[aria-label="Seleccionar columna"]').selectOption({ label: columnLabel });
  // exact:true — screens like Usuarios/Servicios also have an "Agregar X" create button
  // whose accessible name otherwise substring-matches "Agregar" (strict-mode violation).
  await page.getByRole('button', { name: 'Agregar', exact: true }).click();
  await page.getByPlaceholder('Filtrar…').fill(value);
}

test.describe('Staff CRUD — services, clients, resources, users (real GenericForm/GenericTable UI)', () => {
  test('admin creates a new service through the real form', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('link', { name: 'Servicios' }).click();

    await expect(page.locator('table')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Agregar Servicio' }).click();

    const uniqueName = `Servicio E2E ${Date.now()}`;
    await page.locator('#name').fill(uniqueName);
    await page.locator('#default_duration_minutes').fill('35');
    await page.locator('#default_price_ars').fill('4500.00');

    const createResponse = page.waitForResponse(
      (r) => r.url().endsWith('/api/services') && r.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await page.getByRole('button', { name: 'Guardar' }).click();
    const resp = await createResponse;
    expect(resp.status()).toBeLessThan(300);
    const body = await resp.json();
    expect(body.success).toBe(true);
    expect(body.data.name).toBe(uniqueName);

    // Panel closes and the table reloads — the small seeded catalog (~5 rows) fits on page 1.
    await expect(page.getByText(uniqueName)).toBeVisible({ timeout: 10_000 });
  });

  test("admin edits a client's field and it persists after a fresh page reload", async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('link', { name: 'Clientes' }).click();
    await expect(page.locator('table')).toBeVisible({ timeout: 15_000 });

    // Bleeding Gums Murphy (demo_client30) is not referenced by any other spec.
    await filterTableBy(page, 'Nombre', 'Bleeding Gums Murphy');
    const row = page.getByText('Bleeding Gums Murphy').first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();

    const noteText = `Nota E2E ${Date.now()}`;
    const notesField = page.locator('#notes');
    await expect(notesField).toBeVisible({ timeout: 10_000 });
    await notesField.fill(noteText);

    const updateResponse = page.waitForResponse(
      (r) => /\/api\/clients\/\d+$/.test(r.url()) && r.request().method() === 'PUT',
      { timeout: 10_000 },
    );
    await page.getByRole('button', { name: 'Guardar' }).click();
    const resp = await updateResponse;
    expect(resp.status()).toBeLessThan(300);
    const body = await resp.json();
    expect(body.data.notes).toBe(noteText);

    // Prove server persistence, not just in-memory form state: hard-reload and re-filter.
    // Prove SERVER persistence with a fresh read: navigate away and back (remount re-fetches
    // the list from the server), reopen the row, and confirm the note came back from the DB.
    await page.getByRole('link', { name: 'Servicios' }).click();
    await expect(page.locator('table')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('link', { name: 'Clientes' }).click();
    await expect(page.locator('table')).toBeVisible({ timeout: 15_000 });
    await filterTableBy(page, 'Nombre', 'Bleeding Gums Murphy');
    await page.getByText('Bleeding Gums Murphy').first().click();
    await expect(page.locator('#notes')).toHaveValue(noteText, { timeout: 10_000 });
  });

  test('admin deactivates a resource — expects a "Desactivar" action in the edit panel', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('link', { name: 'Recursos' }).click();
    await expect(page.locator('table')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText('Consultorio 1')).toBeVisible({ timeout: 10_000 });
    await page.getByText('Consultorio 1').click();

    // Parity check: ClientsView and ProfessionalsView both render a destructive
    // "Desactivar X" button inside the edit DetailPanel, wired to deleteRow() + a
    // ConfirmDialog. ResourcesView defines the identical confirmDelete()/ConfirmDialog
    // plumbing but never renders the trigger button, so this action is currently
    // unreachable from the UI — this assertion is expected to fail, documenting that gap.
    const deactivateButton = page.getByRole('button', { name: /Desactivar recurso|Eliminar recurso|^Desactivar$|^Eliminar$/i });
    await expect(deactivateButton).toBeVisible({ timeout: 5_000 });

    await deactivateButton.click();
    const confirmButton = page.getByRole('button', { name: /Desactivar|Eliminar/i }).last();
    await expect(confirmButton).toBeVisible({ timeout: 5_000 });
    await confirmButton.click();

    // If the UI gap above is ever fixed, this proves the deactivation actually took effect.
    await expect(page.getByText('Consultorio 1')).not.toBeVisible({ timeout: 10_000 });
  });

  test('Usuarios screen lists seeded staff via GET /api/users', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    // The 'users' SSOT table is marked `protected: true`, and assertCrudAllowed() 404s
    // ALL operations — including read — on protected tables. But UsersView.vue lists
    // rows via the generic GenericTable/listRows('users', ...) path, which needs
    // GET /api/users to succeed. Expected to fail: this makes the Usuarios table
    // permanently empty for every admin, with no distinct error shown (GenericTable
    // renders the same "no rows" EmptyState for both a real 404 and a genuinely empty
    // table — see loadError in GenericTable.vue, which is set but never rendered).
    const usersListResponse = page.waitForResponse(
      (r) => r.url().includes('/api/users') && r.request().method() === 'GET',
      { timeout: 10_000 },
    );
    await page.getByRole('link', { name: 'Usuarios' }).click();
    const listResp = await usersListResponse;
    const listBody = await listResp.json();
    expect(listResp.status(), `GET /api/users returned ${listResp.status()}: ${JSON.stringify(listBody)}`).toBe(200);
    expect(listBody.data.length, 'Usuarios table should list at least the seeded staff accounts').toBeGreaterThan(0);
  });

  test('admin creates a new user through the real form', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('link', { name: 'Usuarios' }).click();
    await expect(page.locator('table')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Agregar usuario' }).click();

    const uniqueUsername = `e2e_user_${Date.now()}`;
    await page.locator('#username').fill(uniqueUsername);
    await page.locator('#email').fill(`${uniqueUsername}@demo.test`);
    await page.locator('#password').fill('e2e-secure-pass-789');
    await page.locator('#role').selectOption('Receptionist');
    await page.locator('#display_name').fill('E2E Test User');

    const createResponse = page.waitForResponse(
      (r) => r.url().includes('/api/admin/users') && r.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await page.getByRole('button', { name: 'Guardar' }).click();
    const resp = await createResponse;
    expect(resp.status()).toBeLessThan(300);
    const body = await resp.json();
    expect(body.username).toBe(uniqueUsername);

    // Confirm the created account is real and usable, independent of the broken
    // Usuarios listing: log in as it directly.
    const newUserContext = await page.context().browser()!.newContext();
    const newUserPage = await newUserContext.newPage();
    const loginRes = await newUserPage.request.post('/api/auth/login', {
      data: { username: uniqueUsername, password: 'e2e-secure-pass-789' },
    });
    expect(loginRes.status()).toBe(200);
    const loginBody = await loginRes.json();
    expect(loginBody.user.role).toBe('Receptionist');
    await newUserContext.close();
  });
});
