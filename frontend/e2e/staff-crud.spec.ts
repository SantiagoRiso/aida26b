import { test, expect } from '@playwright/test';
import { login, DEMO_ACCOUNTS, clientSearchBox, searchClientsByName, withAdmin, es } from './helpers';

// Rows the create tests add. Cleaning them up keeps the catalog/user list small across local re-runs
// so their own "small seeded set fits on page 1" reads stay valid; services are soft-deletable and
// users are soft-deactivated.
const createdServiceIds: number[] = [];
const createdUserIds: number[] = [];

test.afterAll(async ({ browser }) => {
  await withAdmin(browser, async (adminPage) => {
    for (const id of createdServiceIds) await adminPage.request.delete(`/api/services/${id}`).catch(() => {});
    for (const id of createdUserIds) await adminPage.request.post(`/api/admin/users/${id}/deactivate`).catch(() => {});
  });
});

test.describe('Staff CRUD — services, clients, resources, users (real GenericForm/GenericTable UI)', () => {
  test('admin creates a new service through the real form', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    // Services live inside the Negocio (business) page now — there is no top-level Servicios nav.
    await page.getByRole('link', { name: es.nav.business }).click();

    const addServiceButton = page.getByRole('button', { name: 'Agregar servicio' });
    await expect(addServiceButton).toBeVisible({ timeout: 15_000 });
    await addServiceButton.click();

    const uniqueName = `Servicio E2E ${Date.now()}`;
    await page.locator('#name').fill(uniqueName);
    await page.locator('#default_duration_minutes').fill('35');
    await page.locator('#default_price_ars').fill('4500.00');

    const createResponse = page.waitForResponse(
      (r) => r.url().endsWith('/api/services') && r.request().method() === 'POST',
      { timeout: 10_000 },
    );
    // Scope to the create dialog — the Negocio page's General section has its own "Guardar".
    await page.getByRole('dialog').getByRole('button', { name: es.actions.save }).click();
    const resp = await createResponse;
    expect(resp.status()).toBeLessThan(300);
    const body = await resp.json();
    expect(body.success).toBe(true);
    expect(body.data.name).toBe(uniqueName);
    if (body.data?.id != null) createdServiceIds.push(Number(body.data.id));

    // Panel closes and the table reloads — the small seeded catalog (~5 rows) fits on page 1.
    await expect(page.getByText(uniqueName)).toBeVisible({ timeout: 10_000 });
  });

  test("admin edits a client's field and it persists after a fresh page reload", async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('link', { name: es.nav.clients }).click();

    // Clientes is a bespoke list with a name and a DNI search box (no generic column filter).
    // Bleeding Gums Murphy (demo_client30) is not referenced by any other spec.
    await searchClientsByName(page, 'Bleeding Gums Murphy');
    const row = page.getByText('Bleeding Gums Murphy').first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();

    // ClientDetail opens; the note is edited through the "Editar perfil" GenericForm.
    await page.getByRole('button', { name: es.users.editProfile }).click();
    const noteText = `Nota E2E ${Date.now()}`;
    const notesField = page.locator('#notes');
    await expect(notesField).toBeVisible({ timeout: 10_000 });
    await notesField.fill(noteText);

    const updateResponse = page.waitForResponse(
      (r) => /\/api\/clients\/\d+$/.test(r.url()) && r.request().method() === 'PUT',
      { timeout: 10_000 },
    );
    await page.getByRole('button', { name: es.actions.save }).click();
    const resp = await updateResponse;
    expect(resp.status()).toBeLessThan(300);
    const body = await resp.json();
    expect(body.data.notes).toBe(noteText);

    // Prove SERVER persistence with a fresh read: a full page reload re-fetches everything from the
    // server (and dismisses the open detail panel), then reopen the row + edit form and confirm the
    // note came back from the DB.
    await page.reload();
    await searchClientsByName(page, 'Bleeding Gums Murphy');
    await page.getByText('Bleeding Gums Murphy').first().click();
    await page.getByRole('button', { name: es.users.editProfile }).click();
    await expect(page.locator('#notes')).toHaveValue(noteText, { timeout: 10_000 });
  });

  test('admin deletes (soft-deactivates) a seeded resource from the Recursos list', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    // Resources (Salas) live inside the Negocio page as an inline list with a per-row Eliminar
    // button wired to a ConfirmDialog → DELETE — not a DetailPanel edit form.
    await page.getByRole('link', { name: es.nav.business }).click();

    // Consultorio 5 is the least-referenced seeded room; deletion is a soft delete.
    const roomRow = page.locator('li', { hasText: 'Consultorio 5' });
    await expect(roomRow).toBeVisible({ timeout: 15_000 });
    await roomRow.getByRole('button', { name: es.actions.delete }).click();

    const deleteResponse = page.waitForResponse(
      (r) => /\/api\/resources\/\d+$/.test(r.url()) && r.request().method() === 'DELETE',
      { timeout: 10_000 },
    );
    // ConfirmDialog's own confirm button (scoped to the dialog — the row button shares its label).
    await page.getByRole('dialog').getByRole('button', { name: es.actions.delete }).click();
    const resp = await deleteResponse;
    expect(resp.status()).toBeLessThan(300);

    await expect(page.getByText('Consultorio 5')).toHaveCount(0, { timeout: 10_000 });

    // Re-read persists: remount the section (navigate away and back) and confirm it stays gone.
    await page.getByRole('link', { name: es.nav.clients }).click();
    await expect(clientSearchBox(page)).toBeVisible({ timeout: 15_000 });
    await page.getByRole('link', { name: es.nav.business }).click();
    await expect(page.locator('li', { hasText: 'Consultorio 4' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Consultorio 5')).toHaveCount(0);
  });

  test('Usuarios screen lists seeded staff via GET /api/users', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    // The 'users' SSOT table stays `protected: true` (no generic writes) but now carves out a
    // read exception (crud.read + roleRequired.read: ['Admin']), so GET /api/users succeeds for
    // an admin. UsersView.vue lists rows via GenericTable/listRows('users', ...) over that route.
    const usersListResponse = page.waitForResponse(
      (r) => r.url().includes('/api/users') && r.request().method() === 'GET',
      { timeout: 10_000 },
    );
    await page.getByRole('link', { name: es.nav.users }).click();
    const listResp = await usersListResponse;
    const listBody = await listResp.json();
    expect(listResp.status(), `GET /api/users returned ${listResp.status()}: ${JSON.stringify(listBody)}`).toBe(200);
    expect(listBody.data.length, 'Usuarios table should list at least the seeded staff accounts').toBeGreaterThan(0);
  });

  test('admin creates a new user through the real form', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('link', { name: es.nav.users }).click();
    await expect(page.locator('table')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: es.users.addUser }).click();

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
    await page.getByRole('button', { name: es.actions.save }).click();
    const resp = await createResponse;
    expect(resp.status()).toBeLessThan(300);
    const body = await resp.json();
    // The admin create-user handler wraps its payload: { success, data: { id, username, role } }.
    expect(body.data.username).toBe(uniqueUsername);
    if (body.data?.id != null) createdUserIds.push(Number(body.data.id));

    // Confirm the created account is real and usable, independent of the Usuarios listing
    // (asserted separately above): log in as it directly.
    const newUserContext = await page.context().browser()!.newContext();
    const newUserPage = await newUserContext.newPage();
    const loginRes = await newUserPage.request.post('/api/auth/login', {
      data: { username: uniqueUsername, password: 'e2e-secure-pass-789' },
    });
    expect(loginRes.status()).toBe(200);
    const loginBody = await loginRes.json();
    expect(loginBody.data.user.role).toBe('Receptionist');
    await newUserContext.close();
  });
});
