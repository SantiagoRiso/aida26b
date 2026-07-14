import { test, expect } from '@playwright/test';
import type { Page, APIRequestContext } from '@playwright/test';
import { login, DEMO_ACCOUNTS, openScreen, es } from './helpers';

/**
 * CalendarGrantsSection — binary "who may manage this professional's calendar" list. Mounted twice:
 * inside BusinessView (any professional, via ProfessionalPicker) and inside ProfileView (self, no
 * picker — professionalUserId is always auth.user.id). Both the ProfessionalPicker and the section's
 * own "Give access" field are plain native <select>s here (not the searchable Combobox variant other
 * pickers use — Selector only renders a Combobox when `searchable` is passed, which neither call site
 * does), so this spec drives them with `selectOption`, not `selectFromCombobox`.
 *
 * All fixtures are fresh, self-seeded staff: "Dr. Marvin Monroe" (a brand-new Professional — the name
 * collides with a seeded *client* of the same display name, but professionals and clients are
 * different tables/endpoints, so there's no ambiguity) plus two throwaway Receptionists (grantee2,
 * grantee3) and a second empty professional used only to prove the switch-clears-selection behavior.
 * The one pre-existing fixture touched is demo_recep, granted to Marvin in beforeAll to exercise the
 * "already granted" exclusion — a read/grant on demo_recep, never a mutation to any seeded professional.
 */

interface Staff { id: number; label: string; username: string; password: string }

async function createStaff(req: APIRequestContext, role: 'Professional' | 'Receptionist', label: string): Promise<Staff> {
  const tag = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const username = `e2e_p5_grants_${role.toLowerCase()}_${tag}`;
  const password = 'e2e-secure-pass-789';
  const res = await req.post('/api/admin/users', {
    data: { username, email: `${username}@demo.test`, password, role, display_name: label },
  });
  const body = await res.json();
  if (!res.ok() || !body.data?.id) throw new Error(`create ${role} failed: ${res.status()} ${JSON.stringify(body)}`);
  return { id: Number(body.data.id), label, username, password };
}

// The grants API lives under /calendar-grants (grantPaths in shared/src/ssot/api-paths.ts), not
// /grants — the grant list, the grantable-staff list, create, and revoke all share that root.
async function findGranteeId(req: APIRequestContext, username: string): Promise<number> {
  const res = await req.get('/api/calendar-grants/grantable-staff');
  const body = await res.json();
  const row = (body.data ?? []).find((r: { username: string }) => r.username === username);
  if (!row) throw new Error(`grantable staff '${username}' not found`);
  return Number(row.id);
}

async function pickProfessional(page: Page, label: string): Promise<void> {
  // The list GET carries a ?professional_user_id= query; grantable-staff is /calendar-grants/grantable-staff
  // (no query) — matching on the query string awaits the right response, not the mount-time staff fetch.
  const resp = page.waitForResponse((r) => r.url().includes('/calendar-grants?') && r.request().method() === 'GET', { timeout: 10_000 });
  await page.locator('select#schedule-professional-select').selectOption({ label });
  await resp;
}

// The heading + CalendarGrantsSection share one inner div; that div's own ancestor (space-y-6) also
// "has" the heading, so `.last()` picks the innermost (most specific) match, not the wider wrapper
// that also contains ProfessionalServicesSection.
const grantsSection = (page: Page) =>
  page.locator('div').filter({ has: page.getByRole('heading', { name: es.business.calendarPermissions }) }).last();

let marvin: Staff;
let marvinId: number;
let demoRecepId: number;
let grantee2: Staff;
let grantee3: Staff;
const ts = Date.now();
const MARVIN = `Dr. Marvin Monroe (E2E ${ts})`;
const PROF2 = `E2E P5 Grants Prof2 ${ts}`;
// The "Give access" candidate list renders each staff member's display_name (seed-demo.ts), not
// their username — the grant *list* shows grantee_username instead, so the two checks below
// deliberately use different strings for the same account.
const DEMO_RECEP_DISPLAY_NAME = 'Recepcionista Demo';

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
  const req = page.request;

  const [marvinStaff] = await Promise.all([
    createStaff(req, 'Professional', MARVIN),
    createStaff(req, 'Professional', PROF2),
  ]);
  marvin = marvinStaff;
  marvinId = marvin.id;

  [grantee2, grantee3] = await Promise.all([
    createStaff(req, 'Receptionist', `E2E P5 Grantee2 ${ts}`),
    createStaff(req, 'Receptionist', `E2E P5 Grantee3 ${ts}`),
  ]);

  demoRecepId = await findGranteeId(req, DEMO_ACCOUNTS.receptionistWithGrant.username);
  const grantRes = await req.post('/api/calendar-grants', {
    data: { professional_user_id: marvinId, grantee_user_id: demoRecepId },
  });
  if (!grantRes.ok()) throw new Error(`pre-grant failed: ${grantRes.status()} ${await grantRes.text()}`);

  await context.close();
});

test.describe('Calendar grants — Give access / Remove access', () => {
  test('no professional selected shows the prompt', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await openScreen(page, es.nav.business);
    await expect(grantsSection(page).getByText(es.grants.selectProfessional)).toBeVisible({ timeout: 15_000 });
  });

  test('existing grant is listed; Give access excludes self and the already-granted', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await openScreen(page, es.nav.business);
    await pickProfessional(page, MARVIN);

    const section = grantsSection(page);
    await expect(section.getByText(DEMO_ACCOUNTS.receptionistWithGrant.username)).toBeVisible({ timeout: 10_000 });

    const select = section.locator('select#grant-grantee-select');
    // Self (Marvin) and the already-granted demo_recep never appear as candidates. The candidate
    // list is keyed by display_name, not username — matching on the username here would trivially
    // pass regardless of whether the exclusion logic worked (the label never contains it).
    await expect(select.locator('option').filter({ hasText: MARVIN })).toHaveCount(0);
    await expect(select.locator('option').filter({ hasText: DEMO_RECEP_DISPLAY_NAME })).toHaveCount(0);
    // Ungranted staff remain selectable.
    await expect(select.locator('option').filter({ hasText: grantee2.label })).toHaveCount(1);
    await expect(select.locator('option').filter({ hasText: grantee3.label })).toHaveCount(1);
  });

  test('Give access grants a new candidate', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await openScreen(page, es.nav.business);
    await pickProfessional(page, MARVIN);

    const section = grantsSection(page);
    await section.locator('select#grant-grantee-select').selectOption({ label: grantee3.label });

    const grantResp = page.waitForResponse((r) => r.url().includes('/calendar-grants') && r.request().method() === 'POST', { timeout: 10_000 });
    await section.getByRole('button', { name: es.grants.giveAccess }).click();
    expect((await grantResp).ok()).toBe(true);

    await expect(page.getByText(es.toast.saved)).toBeVisible({ timeout: 5_000 });
    await expect(section.getByText(grantee3.username)).toBeVisible({ timeout: 10_000 });

    // Durable: reload and re-pick — the grant survives a fresh mount.
    await page.reload();
    await pickProfessional(page, MARVIN);
    await expect(grantsSection(page).getByText(grantee3.username)).toBeVisible({ timeout: 10_000 });
  });

  test('a raced duplicate grant surfaces a server error, not a crash', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await openScreen(page, es.nav.business);
    await pickProfessional(page, MARVIN);

    const section = grantsSection(page);
    // grantee2 is still ungranted and selectable at this point.
    await section.locator('select#grant-grantee-select').selectOption({ label: grantee2.label });

    // Simulate a second admin/tab granting the exact same pair a moment earlier — the UI's exclusion
    // list can't prevent a race, so the server's 409 is the real backstop.
    const raceRes = await page.request.post('/api/calendar-grants', {
      data: { professional_user_id: marvinId, grantee_user_id: grantee2.id },
    });
    expect(raceRes.ok()).toBe(true);

    await section.getByRole('button', { name: es.grants.giveAccess }).click();
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 10_000 });

    // Exactly one grant row for grantee2 exists — the failed UI submit did not double it up.
    const grants = await (await page.request.get(`/api/calendar-grants?professional_user_id=${marvinId}`)).json();
    const forGrantee2 = (grants.data ?? []).filter((g: { grantee_user_id: number }) => Number(g.grantee_user_id) === grantee2.id);
    expect(forGrantee2.length).toBe(1);
  });

  test('Remove access revokes a grant', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await openScreen(page, es.nav.business);
    await pickProfessional(page, MARVIN);

    const section = grantsSection(page);
    const row = section.locator('li').filter({ hasText: grantee3.username });
    await expect(row).toBeVisible({ timeout: 10_000 });

    const revokeResp = page.waitForResponse((r) => r.url().includes('/calendar-grants/') && r.request().method() === 'DELETE', { timeout: 10_000 });
    await row.getByRole('button', { name: es.grants.removeAccess }).click();
    expect((await revokeResp).ok()).toBe(true);

    await expect(section.getByText(grantee3.username)).toHaveCount(0, { timeout: 10_000 });

    const grants = await (await page.request.get(`/api/calendar-grants?professional_user_id=${marvinId}`)).json();
    expect((grants.data ?? []).some((g: { grantee_user_id: number }) => Number(g.grantee_user_id) === grantee3.id)).toBe(false);
  });

  test('switching professional clears the pending selection and shows the new professional empty', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await openScreen(page, es.nav.business);
    await pickProfessional(page, MARVIN);

    // grantee3 was revoked in the previous test, so it's available to select again here.
    const section = grantsSection(page);
    const select = section.locator('select#grant-grantee-select');
    await select.selectOption({ label: grantee3.label });
    await expect(select).toHaveValue(String(grantee3.id));

    // A leftover selection from Marvin must not survive the switch to a different professional.
    await pickProfessional(page, PROF2);
    await expect(select).toHaveValue('');
    await expect(section.getByText(es.grants.noneYet)).toBeVisible({ timeout: 10_000 });
  });

  test('self-view via Profile shows the professional their own grant list', async ({ page }) => {
    // Monroe (the grants professional the other tests drive via the admin BusinessView) is a seeded
    // professional with NO login account, so this self-view instead runs as demo_pro (Dra. Marge
    // Bouvier) — the only seeded login professional. She already has demo_recep granted in the seed,
    // so the self Profile view renders that grant without this test mutating anything (collision-free).
    await login(page, DEMO_ACCOUNTS.professionalUser.username, DEMO_ACCOUNTS.professionalUser.password);

    await openScreen(page, es.nav.profile);
    const section = page.locator('section').filter({ has: page.getByText(es.profile.whoManages) });
    // Her seeded grantee is listed by username. (ProfileView mounts the same CalendarGrantsSection as
    // BusinessView — there is no separate read-only variant — so the assertion is that the list
    // renders, not that controls are hidden.)
    await expect(section.getByText(DEMO_ACCOUNTS.receptionistWithGrant.username)).toBeVisible({ timeout: 15_000 });
    // No ProfessionalPicker on the self view — nothing to pick, it's always "me".
    await expect(page.locator('select#schedule-professional-select')).toHaveCount(0);
  });
});
