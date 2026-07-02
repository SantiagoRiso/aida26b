import { test, expect } from '@playwright/test';
import { login, DEMO_ACCOUNTS } from './helpers';

test.describe('Staff nav — role visibility', () => {
  test('admin sees Usuarios and Auditoría in sidebar', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await expect(page.getByRole('link', { name: 'Usuarios' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Auditoría' })).toBeVisible();
  });

  test('professional does not see Usuarios or Auditoría', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.professionalUser.username, DEMO_ACCOUNTS.professionalUser.password);
    await expect(page.getByRole('link', { name: 'Usuarios' })).not.toBeVisible();
    await expect(page.getByRole('link', { name: 'Auditoría' })).not.toBeVisible();
  });

  test('receptionist does not see Usuarios or Auditoría', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.receptionistWithGrant.username, DEMO_ACCOUNTS.receptionistWithGrant.password);
    await expect(page.getByRole('link', { name: 'Usuarios' })).not.toBeVisible();
    await expect(page.getByRole('link', { name: 'Auditoría' })).not.toBeVisible();
  });

  test('admin lands on staff dashboard after login', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);
    await expect(page).toHaveURL(/\/staff\//);
  });
});
