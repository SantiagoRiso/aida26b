import { test, expect } from '@playwright/test';
import { login, DEMO_ACCOUNTS } from './helpers';

/**
 * Runs BEFORE ledger-balance.spec.ts alphabetically — the balance-view test below
 * asserts demo_client's (Homero's) zero seeded balance, which ledger-balance.spec.ts
 * never mutates (it uses Lenny Leonard instead, precisely to avoid this coupling).
 * Documented here too in case file ordering ever changes.
 */
test.describe('Client portal — own appointments, balance, and preferences', () => {
  test('client views own appointments (calendar + status list)', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.client.username, DEMO_ACCOUNTS.client.password);
    await page.getByRole('link', { name: 'Mis turnos' }).click();

    await expect(page.getByRole('heading', { name: 'Mis turnos' })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.fc')).toBeVisible({ timeout: 10_000 });

    // demo_client has both a completed (past) and a scheduled (future) seeded appointment.
    const statusBadge = page.locator('li').filter({ hasText: /Solicitado|Programado|Completado|Cancelado|Ausente|Rechazado/ }).first();
    await expect(statusBadge).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('li', { hasText: /Turno #/ }).first()).toBeVisible({ timeout: 10_000 });
  });

  test('client views own read-only balance + movement history — no edit/create affordance', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.client.username, DEMO_ACCOUNTS.client.password);
    await page.getByRole('link', { name: 'Mi saldo' }).click();

    await expect(page.getByText('Saldo actual')).toBeVisible({ timeout: 10_000 });
    // Homero is seeded fully paid (charge 6500 + payment 6500) → zero balance, shown as paid-up.
    await expect(page.getByText('Tu cuenta está al día.')).toBeVisible({ timeout: 10_000 });

    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 10_000 });
    await expect(table.locator('tbody tr').first()).toBeVisible({ timeout: 10_000 });

    await expect(page.getByRole('button', { name: /nuevo movimiento|editar|eliminar|borrar/i })).not.toBeVisible();
  });

  test('client changes interface language via Preferencias', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.client.username, DEMO_ACCOUNTS.client.password);
    await page.getByRole('link', { name: 'Preferencias' }).click();

    await expect(page.getByRole('heading', { name: 'Preferencias' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('language-toggle')).toBeVisible();

    await page.getByTestId('lang-en').click();
    await expect(page.getByRole('link', { name: 'Preferences', exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('heading', { name: 'Preferences' })).toBeVisible();

    await page.getByTestId('lang-es').click();
    await expect(page.getByRole('link', { name: 'Preferencias', exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('heading', { name: 'Preferencias' })).toBeVisible();
  });
});
