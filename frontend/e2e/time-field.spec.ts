import { test, expect } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { loginAs, openScreen } from './helpers';

// The 24h TimeField (frontend/src/components/shared/TimeField.vue) is a custom masked input with a
// click-open hour/minute adjuster. The admin Negocio → Días festivos "Desde" field is an
// always-visible instance, so it drives the component end-to-end without creating any data
// (nothing is submitted — the add-closure form is only typed into).
test.describe('TimeField — 24h masked time input', () => {
  let desde: Locator;

  test.beforeEach(async ({ page }) => {
    await loginAs(page, 'adminUser');
    await openScreen(page, 'Negocio');
    desde = page.locator('input[placeholder="hh:mm"]').first();
    await expect(desde).toBeVisible();
  });

  async function retype(field: Locator, text: string) {
    await field.fill('');
    if (text) await field.pressSequentially(text);
  }

  test('masks, auto-completes, and disambiguates as you type', async () => {
    // The colon appears as soon as the hour is complete — before any minute is typed.
    await retype(desde, '09');
    await expect(desde).toHaveValue('09:');
    await desde.pressSequentially('30');
    await expect(desde).toHaveValue('09:30');

    // A leading 3–9 can't grow into a valid hour, so the colon lands immediately.
    await retype(desde, '9');
    await expect(desde).toHaveValue('9:');

    // A fully-determined time normalizes to a padded HH:MM at once:
    //   '29' → 2 is the hour, 9 can't be a minute-tens → 02:09.
    await retype(desde, '29');
    await expect(desde).toHaveValue('02:09');
    //   '1:00' → an explicit colon locks the hour to 1 (never 10:) → 01:00.
    await retype(desde, '1:00');
    await expect(desde).toHaveValue('01:00');

    // Still-ambiguous bare digits stay live — the minute could still grow to 10:0x.
    await retype(desde, '100');
    await expect(desde).toHaveValue('10:0');

    // A colon typed when one already exists is absorbed, not doubled.
    await desde.pressSequentially(':5');
    await expect(desde).toHaveValue('10:05');

    // Deletion removes the auto-colon cleanly instead of re-inserting it.
    await desde.press('Backspace'); // 10:0
    await desde.press('Backspace'); // 10:
    await desde.press('Backspace'); // 10
    await expect(desde).toHaveValue('10');
  });

  test('pads a still-ambiguous partial on blur', async () => {
    // '9:3' stays live while typing — the minute could still grow to 9:3x.
    await retype(desde, '9:3');
    await expect(desde).toHaveValue('9:3');
    // On blur the lone minute digit is the tens place, so it completes to 09:30 (not 09:03).
    await desde.press('Tab');
    await expect(desde).toHaveValue('09:30');
  });

  test('a single click opens the adjuster and it changes hour and minutes', async ({ page }) => {
    await retype(desde, '');
    // A single click focuses the field AND opens the adjuster popover.
    await desde.click();
    const hourUp = page.getByRole('button', { name: '+ hora', exact: true });
    await expect(hourUp).toBeVisible();

    await hourUp.click();
    await expect(desde).toHaveValue('01:00');

    // The minute adjuster steps by 5.
    await page.getByRole('button', { name: '+ minutos', exact: true }).click();
    await expect(desde).toHaveValue('01:05');

    // The hour decrements independently of the minutes.
    await page.getByRole('button', { name: '- hora', exact: true }).click();
    await expect(desde).toHaveValue('00:05');
  });
});
