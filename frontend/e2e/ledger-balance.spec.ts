import { test, expect } from '@playwright/test';
import { login, DEMO_ACCOUNTS } from './helpers';

/**
 * The seed gives demo_client_overdue (Bart Simpson) a fixed, deterministic ledger:
 * charge 8000 + charge 8000 + payment 5000 + adjustment_debit 500.
 * balance_ars = (charges + adjustment_debit) - (payments + adjustment_credit)
 *             = (8000 + 8000 + 500) - 5000 = 11500.00. Asserted exactly below.
 */
test.describe('Ledger — derived balance and immutability', () => {
  test('ledger screen loads with client picker and balance section', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('link', { name: 'Ledger' }).click();

    // exact:true avoids matching the "Clientes" nav link.
    const clientLabel = page.getByText('Cliente', { exact: true });
    await expect(clientLabel.first()).toBeVisible();

    const emptyHeading = page.getByRole('heading', { name: 'Seleccioná un cliente' });
    await expect(emptyHeading).toBeVisible();
  });

  test('selecting demo_client_overdue shows the exact server-derived overdue balance', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('link', { name: 'Ledger' }).click();

    const clientSelect = page.locator('select').first();
    await expect(clientSelect).toBeVisible();
    await expect(clientSelect.locator('option', { hasText: 'Bart Simpson' })).toBeAttached({ timeout: 10_000 });
    await clientSelect.selectOption({ label: 'Bart Simpson' });

    // Positive balance = client owes money → rendered with text-destructive.
    const balanceBanner = page.locator('.text-destructive').filter({ hasText: /\d/ }).first();
    await expect(balanceBanner).toBeVisible({ timeout: 10_000 });
    await expect(balanceBanner).toContainText(/11[.,]500[.,]00/);
  });

  test('ledger entries table shows the four seeded entries with type badges — no edit or delete buttons', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('link', { name: 'Ledger' }).click();

    const clientSelect = page.locator('select').first();
    await expect(clientSelect.locator('option', { hasText: 'Bart Simpson' })).toBeAttached({ timeout: 10_000 });
    await clientSelect.selectOption({ label: 'Bart Simpson' });

    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 10_000 });

    const rows = table.locator('tbody tr');
    await expect(rows).toHaveCount(4, { timeout: 10_000 });

    // Ledger entries are immutable (server-enforced via REVOKE + trigger) — no edit or
    // delete affordance in the UI.
    await expect(table.getByRole('button', { name: /editar|edit/i })).not.toBeVisible();
    await expect(table.getByRole('button', { name: /eliminar|delete|borrar/i })).not.toBeVisible();
  });

  test('staff can open Nuevo movimiento to create a new ledger entry', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('link', { name: 'Ledger' }).click();

    const clientSelect = page.locator('select').first();
    await expect(clientSelect.locator('option', { hasText: 'Bart Simpson' })).toBeAttached({ timeout: 10_000 });
    await clientSelect.selectOption({ label: 'Bart Simpson' });

    const newEntryBtn = page.getByRole('button', { name: 'Nuevo movimiento' });
    await expect(newEntryBtn).toBeVisible();
    await newEntryBtn.click();

    const entryTypeSelect = page.locator('select').nth(1);
    await expect(entryTypeSelect).toBeVisible({ timeout: 5_000 });
  });

  /**
   * Lenny Leonard (demo_client4) has no seeded ledger entries at all, so his balance
   * starts at exactly zero — a client untouched by any other spec, avoiding cross-file
   * ordering assumptions (Bart/Homero's ledgers are read, but never mutated, elsewhere).
   */
  test('creating a new ledger entry as Admin updates the client balance', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await page.getByRole('link', { name: 'Ledger' }).click();

    const clientSelect = page.locator('select').first();
    await expect(clientSelect.locator('option', { hasText: 'Lenny Leonard' })).toBeAttached({ timeout: 10_000 });
    await clientSelect.selectOption({ label: 'Lenny Leonard' });

    const balanceValue = page.locator('.text-xl.font-semibold.tabular-nums');
    await expect(balanceValue).toBeVisible({ timeout: 10_000 });
    await expect(balanceValue).toContainText(/0[.,]00/);

    await page.getByRole('button', { name: 'Nuevo movimiento' }).click();

    const entryTypeSelect = page.locator('select').nth(1);
    await expect(entryTypeSelect).toBeVisible({ timeout: 5_000 });
    await entryTypeSelect.selectOption({ label: 'Ajuste (débito)' });

    const amountInput = page.locator('input[inputmode="decimal"]');
    await amountInput.fill('1234.56');

    const createResponse = page.waitForResponse(
      (r) => r.url().endsWith('/api/ledger') && r.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await page.getByRole('button', { name: 'Guardar' }).click();
    const resp = await createResponse;
    expect(resp.status()).toBeLessThan(300);
    const body = await resp.json();
    expect(body.success).toBe(true);
    expect(body.data.entry_type).toBe('adjustment_debit');
    expect(body.data.amount_ars).toBe('1234.56');

    // Panel closes and the view reloads balance + entries for the still-selected client.
    await expect(balanceValue).toContainText(/1[.,]234[.,]56/, { timeout: 10_000 });

    const rows = page.locator('table tbody tr');
    await expect(rows).toHaveCount(1, { timeout: 10_000 });
    await expect(rows.first()).toContainText('1.234,56');
  });
});
