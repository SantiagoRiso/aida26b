import { test, expect } from '@playwright/test';
import type { Page, APIRequestContext } from '@playwright/test';
import {
  login,
  DEMO_ACCOUNTS,
  findProfessionalId,
  findServiceId,
  scheduleViaApi,
  cleanupUsers,
  isoDaysFromNow,
  clientSearchBox,
  searchClientsByName,
  es,
} from './helpers';
import { DEMO_SERVICE_NAMES } from '../../shared/src/dev-fixtures';

/**
 * ClientDetail gating. The subtle rule is ledger access: `ledgerAccessible = Admin OR the viewer has
 * seen this client` (their scoped appointment list is non-empty). A Professional/Receptionist sees no
 * Cuenta corriente for a stranger, but it appears the moment a turno links them. Role affordances come
 * from the `clients` descriptor: update = Admin/Receptionist, delete = Admin-only; "Crear usuario"
 * shows only for a contact-only client (no username).
 *
 * Everything is self-seeded via the staff create-user endpoint (contact-only Clients) and the schedule
 * API, on Dr. Julius Hibbert / Dra. Marge Bouvier at dates no other spec uses — so the fixtures are
 * collision-free on the shared serial dataset. All UI strings come from the `es` SSoT.
 */
async function createContactClient(req: APIRequestContext, displayName: string): Promise<number> {
  // A contact-only client omits username/password (no login) but the endpoint still requires an email.
  const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const res = await req.post('/api/admin/users', {
    data: { role: 'Client', display_name: displayName, email: `e2e_cd_${tag}@demo.test`, dni: `E2E${tag}` },
  });
  const body = await res.json();
  if (!res.ok() || !body.data?.id) throw new Error(`create client failed: ${res.status()} ${JSON.stringify(body)}`);
  return Number(body.data.id);
}

async function openClientByName(page: Page, name: string, opts: { unrelated?: boolean } = {}): Promise<void> {
  // Escape first: a still-open detail panel overlays the sidebar and would swallow the nav click.
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: es.nav.clients }).click();
  await expect(clientSearchBox(page)).toBeVisible({ timeout: 15_000 });
  if (opts.unrelated) await page.getByText(es.clients.includeUnrelated).click();
  await searchClientsByName(page, name);
  await page.getByText(name).first().click();
  await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: 10_000 });
}

const ledgerHeading = (page: Page) => page.getByRole('heading', { name: es.clients.ledgerHeading });

let margeId: number;
let sesionId: number;
let hibbertId: number;
let medicoId: number;
let unseenClientId: number;
let contactClientId: number;
let pendingClientId: number;
let unseenClientName: string;
let contactClientName: string;
let pendingClientName: string;
let pendingApptId: number;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
  const req = page.request;

  [margeId, sesionId, hibbertId, medicoId] = await Promise.all([
    findProfessionalId(page, 'Marge Bouvier'),
    findServiceId(page, DEMO_SERVICE_NAMES.sesion),
    findProfessionalId(page, 'Julius Hibbert'),
    findServiceId(page, DEMO_SERVICE_NAMES.medico),
  ]);

  const ts = Date.now();
  unseenClientName = `E2E CD Unseen ${ts}`;
  contactClientName = `E2E CD Contact ${ts}`;
  pendingClientName = `E2E CD Pending ${ts}`;

  [unseenClientId, contactClientId] = await Promise.all([
    createContactClient(req, unseenClientName),
    createContactClient(req, contactClientName),
  ]);

  pendingClientId = await createContactClient(req, pendingClientName);
  pendingApptId = await scheduleViaApi(page, {
    professional_user_id: hibbertId,
    service_id: medicoId,
    client_user_id: pendingClientId,
    date: isoDaysFromNow(41),
    start: '09:00',
    duration_minutes: 30,
    name: 'e2e client-detail pending',
  });

  await context.close();
});

// Deactivate the throwaway Clients so re-runs don't accumulate rows in the Clientes list. The
// scheduled/canceled appointments they carry are workflow rows on now-relative dates no other spec
// reads, and drop out of every scoped read once their client is deactivated.
test.afterAll(async ({ browser }) => {
  await cleanupUsers(browser, [unseenClientId, contactClientId, pendingClientId]);
});

test.describe('ClientDetail — ledger gating & role affordances', () => {
  test('professional sees no ledger for an unseen client, and it appears once a turno links them', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.professionalUser.username, DEMO_ACCOUNTS.professionalUser.password);

    await openClientByName(page, unseenClientName, { unrelated: true });
    // Stranger → the whole Cuenta corriente section is gated off (no read is even attempted).
    await expect(ledgerHeading(page)).toHaveCount(0);

    // Link them with a turno (this professional is Marge), then the ledger becomes readable.
    await scheduleViaApi(page, {
      professional_user_id: margeId,
      service_id: sesionId,
      client_user_id: unseenClientId,
      date: isoDaysFromNow(43),
      start: '10:00',
      duration_minutes: 50,
      name: 'e2e client-detail seen',
    });
    await page.reload();
    await openClientByName(page, unseenClientName);
    await expect(ledgerHeading(page)).toBeVisible();
    // A Professional is a ledger writer, so the entry affordance shows too.
    await expect(page.getByRole('button', { name: es.clients.loadPayment })).toBeVisible();
  });

  test('admin: contact-only client offers Crear usuario; a login-enabled client does not', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    await openClientByName(page, contactClientName);
    await expect(page.getByRole('button', { name: es.clients.createUser })).toBeVisible();
    await expect(page.getByRole('button', { name: es.users.editProfile })).toBeVisible();
    await expect(page.getByRole('button', { name: es.users.deactivate })).toBeVisible();

    // demo_client (Bart) already logs in, so there is nothing to enable.
    await openClientByName(page, 'Bart Simpson');
    await expect(page.getByRole('button', { name: es.clients.createUser })).toHaveCount(0);
  });

  test('receptionist can edit a client but cannot deactivate', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.receptionistWithGrant.username, DEMO_ACCOUNTS.receptionistWithGrant.password);
    await openClientByName(page, contactClientName, { unrelated: true });

    await expect(page.getByRole('button', { name: es.users.editProfile })).toBeVisible();
    await expect(page.getByRole('button', { name: es.users.deactivate })).toHaveCount(0);
  });

  test('admin cancels a pending turno from the client detail', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await openClientByName(page, pendingClientName);

    await expect(page.getByRole('heading', { name: es.clients.pendingAppointments })).toBeVisible();
    const pendingItem = page.locator('li').filter({ hasText: 'Hibbert' });
    await expect(pendingItem).toBeVisible({ timeout: 10_000 });
    await pendingItem.getByRole('button').click();

    // The confirm dialog's two buttons differ by SSoT key: neutral es.actions.cancel ('Cancelar')
    // vs the destructive confirm es.calendar.cancel ('Cancelar turno'). Click the latter.
    const dialog = page.getByRole('dialog').filter({ hasText: es.clients.cancelBody });
    const cancelResp = page.waitForResponse(
      (r) => /\/appointments\/\d+\/transition/.test(r.url()) && r.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await dialog.getByRole('button', { name: es.calendar.cancel }).click();
    await cancelResp;

    // Durable: the turno is now canceled.
    const after = await (await page.request.get(`/api/appointments/${pendingApptId}`)).json();
    expect(after.data.state).toBe('canceled');
  });
});
