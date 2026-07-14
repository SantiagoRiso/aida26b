import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { login, DEMO_ACCOUNTS, es } from './helpers';

/**
 * Staff ledger management lives inside ClientDetail now (Clientes → open a client), not a standalone
 * "Ledger" screen. Balances are server-derived; entries are immutable (REVOKE + trigger).
 * The seed gives demo_client_overdue (Bart Simpson) a fixed ledger:
 *   charge 8000 + charge 8000 + payment 5000 + adjustment_debit 500
 *   balance = (8000 + 8000 + 500) − 5000 = 11.500,00. Asserted exactly below.
 */
const balanceValue = (page: Page) => page.locator('.text-xl.font-semibold.tabular-nums');
// ClientDetail renders three tables (ledger, pending, history); the ledger table is the only one
// with a "Tipo" (entry-type) column header.
const ledgerTable = (page: Page) =>
  page.locator('table').filter({ has: page.getByRole('columnheader', { name: es.portal.type }) });
// The entry-type <select> in the LedgerEntryForm, located by an option only it carries.
const entryTypeSelect = (page: Page) =>
  page.locator('select').filter({ has: page.locator('option', { hasText: 'Ajuste (débito)' }) });

async function openClientDetail(page: Page, name: string): Promise<void> {
  await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
  await page.getByRole('link', { name: es.nav.clients }).click();
  const search = page.getByPlaceholder(es.clients.searchPlaceholder);
  await expect(search).toBeVisible({ timeout: 15_000 });
  await search.fill(name);
  await page.getByText(name).first().click();
  await expect(page.getByRole('heading', { name: es.clients.ledgerHeading })).toBeVisible({ timeout: 10_000 });
}

test.describe('Ledger — derived balance and immutability (ClientDetail)', () => {
  test('client detail shows the ledger section with balance and entries', async ({ page }) => {
    await openClientDetail(page, 'Bart Simpson');
    await expect(balanceValue(page)).toBeVisible();
    await expect(ledgerTable(page)).toBeVisible();
  });

  test('Bart Simpson shows the exact server-derived overdue balance', async ({ page }) => {
    await openClientDetail(page, 'Bart Simpson');
    const banner = balanceValue(page);
    // Positive balance = client owes → destructive styling.
    await expect(banner).toHaveClass(/text-destructive/);
    await expect(banner).toContainText(/11[.,]500[.,]00/);
  });

  test('ledger entries are shown and immutable — no edit/delete affordance', async ({ page }) => {
    await openClientDetail(page, 'Bart Simpson');
    const table = ledgerTable(page);
    await expect(table.locator('tbody tr')).toHaveCount(4, { timeout: 10_000 });
    await expect(table.getByRole('button', { name: /editar|edit/i })).not.toBeVisible();
    await expect(table.getByRole('button', { name: /eliminar|delete|borrar/i })).not.toBeVisible();
  });

  test('staff can open the load-payment / adjust-balance form', async ({ page }) => {
    await openClientDetail(page, 'Bart Simpson');
    await page.getByRole('button', { name: es.clients.loadPayment }).click();
    await expect(entryTypeSelect(page)).toBeVisible({ timeout: 5_000 });
  });

  /**
   * Lenny Leonard (demo_client4) has no seeded ledger entries, so his balance starts at zero — a
   * client no other spec mutates, avoiding cross-file ordering assumptions.
   */
  test('creating a ledger entry as Admin updates the client balance', async ({ page }) => {
    await openClientDetail(page, 'Lenny Leonard');
    const banner = balanceValue(page);
    await expect(banner).toContainText(/0[.,]00/);

    await page.getByRole('button', { name: es.clients.loadPayment }).click();
    await entryTypeSelect(page).selectOption({ label: 'Ajuste (débito)' });
    await page.locator('input[inputmode="decimal"]').fill('1234.56');

    const createResponse = page.waitForResponse(
      (r) => r.url().endsWith('/api/ledger') && r.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await page.getByRole('button', { name: es.actions.save }).click();
    const resp = await createResponse;
    expect(resp.status()).toBeLessThan(300);
    const body = await resp.json();
    expect(body.data.entry_type).toBe('adjustment_debit');
    expect(body.data.amount_ars).toBe('1234.56');

    // Panel closes and the view reloads balance + entries for the open client.
    await expect(banner).toContainText(/1[.,]234[.,]56/, { timeout: 10_000 });
    await expect(ledgerTable(page).locator('tbody tr')).toHaveCount(1, { timeout: 10_000 });
  });
});
