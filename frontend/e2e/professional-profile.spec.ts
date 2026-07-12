import { test, expect } from '@playwright/test';
import { login, DEMO_ACCOUNTS } from './helpers';

test.describe('Professional profile — self-service edit', () => {
  test('professional edits their profile and it persists', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.professionalUser.username, DEMO_ACCOUNTS.professionalUser.password);

    await page.goto('/staff/profile');
    await page.fill('#pf-phone', '555-0100');
    await page.fill('#pf-bio', 'Updated bio for e2e');
    await page.click('#pf-save');
    await expect(page.locator('text=/guardad|saved/i')).toBeVisible();
    await page.reload();
    await expect(page.locator('#pf-phone')).toHaveValue('555-0100');
  });
});
