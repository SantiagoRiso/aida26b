import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { login, DEMO_ACCOUNTS, searchClientsByName, es } from './helpers';

/**
 * Staff ledger management lives inside ClientDetail now (Clientes → open a client), not a standalone
 * "Ledger" screen. Balances are server-derived; entries are immutable (REVOKE + trigger).
 *
 * Nothing here pins a seeded amount or row count. Completing a session posts its charge, and the
 * seed fills a rolling window of days, so a client's totals change with the calendar. What is
 * stable is the behaviour: the overdue client owes, and posting an entry moves the balance by
 * exactly that entry's amount.
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
  await searchClientsByName(page, name);
  await page.getByText(name).first().click();
  await expect(page.getByRole('heading', { name: es.clients.ledgerHeading })).toBeVisible({ timeout: 10_000 });
}

test.describe('Ledger — derived balance and immutability (ClientDetail)', () => {
  test('client detail shows the ledger section with balance and entries', async ({ page }) => {
    await openClientDetail(page, 'Bart Simpson');
    await expect(balanceValue(page)).toBeVisible();
    await expect(ledgerTable(page)).toBeVisible();
  });

  test('Bart Simpson carries an overdue balance, styled as owed', async ({ page }) => {
    await openClientDetail(page, 'Bart Simpson');
    const banner = balanceValue(page);
    // Positive balance = client owes → destructive styling. He is the one client the seed leaves
    // deliberately unsettled, so the sign is the assertion; the amount tracks the seeded window.
    await expect(banner).toHaveClass(/text-destructive/);
    await expect(banner).not.toContainText(/^\s*-/);
  });

  test('ledger entries are shown and immutable — no edit/delete affordance', async ({ page }) => {
    await openClientDetail(page, 'Bart Simpson');
    const table = ledgerTable(page);
    const rows = table.locator('tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });
    expect(await rows.count()).toBeGreaterThan(0);
    await expect(table.getByRole('button', { name: /editar|edit/i })).not.toBeVisible();
    await expect(table.getByRole('button', { name: /eliminar|delete|borrar/i })).not.toBeVisible();
  });

  test('staff can open the load-payment / adjust-balance form', async ({ page }) => {
    await openClientDetail(page, 'Bart Simpson');
    await page.getByRole('button', { name: es.clients.loadPayment }).click();
    await expect(entryTypeSelect(page)).toBeVisible({ timeout: 5_000 });
  });

  /**
   * Lenny Leonard (demo_client4) is a client no other spec mutates, avoiding cross-file ordering
   * assumptions. His opening balance is read rather than assumed: completing a session bills it, so
   * any client may already carry entries. The assertion is the delta the new entry causes.
   */
  test('creating a ledger entry as Admin moves the balance by that amount', async ({ page }) => {
    await openClientDetail(page, 'Lenny Leonard');
    const banner = balanceValue(page);
    await expect(banner).toBeVisible({ timeout: 10_000 });

    const toNumber = (text: string): number =>
      Number(text.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
    const before = toNumber((await banner.textContent()) ?? '');
    const rowsBefore = await ledgerTable(page).locator('tbody tr').count();

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

    // Panel closes and the view reloads balance + entries for the open client. A debit adjustment
    // raises what the client owes by exactly its amount.
    await expect(ledgerTable(page).locator('tbody tr')).toHaveCount(rowsBefore + 1, { timeout: 10_000 });
    await expect
      .poll(async () => toNumber((await banner.textContent()) ?? ''), { timeout: 10_000 })
      .toBeCloseTo(before + 1234.56, 2);
  });
});
