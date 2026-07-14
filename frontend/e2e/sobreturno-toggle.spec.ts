import { test, expect } from '@playwright/test';
import { login, DEMO_ACCOUNTS, selectFromCombobox, es } from './helpers';

/**
 * Deterministic form-state coverage for the AppointmentForm 'Sobreturno' checkbox
 * (AppointmentForm.vue). Unchecked → SlotPicker is shown and manual hora/duración
 * is hidden; checked → the manual #appt-start + #appt-duration inputs are shown and
 * the SlotPicker is hidden. No FullCalendar coordinate clicks or drags — those are
 * flaky and deliberately avoided in this suite; only the form toggle is exercised.
 *
 * Reschedule mode defaults to sobreturno = true (AppointmentForm's `sobreturno` ref
 * is seeded from `!!props.appointment`), and that path is already exercised by
 * calendar-reschedule.spec.ts (it fills #appt-start directly after Reprogramar), so
 * it is not re-tested here.
 */
test.describe('Sobreturno checkbox — slot-picker ↔ manual entry toggle', () => {
  test('toggling Sobreturno swaps the SlotPicker for manual hora/duración and back', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    await page.getByRole('link', { name: es.nav.calendar }).click();
    await expect(page.locator('.fc')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: es.calendar.newAppointment }).click();

    // A professional makes the SlotPicker meaningful, though its title renders regardless
    // of selection (the picker is gated only by the sobreturno checkbox, not by the fields).
    await selectFromCombobox(page, 'appt-prof', 'Dra. Marge Bouvier');
    await expect(page.locator('input#appt-prof')).toHaveValue(/Marge Bouvier/);

    const slotPickerTitle = page.getByText(es.calendar.slotPickerTitle, { exact: true });
    const startInput = page.locator('#appt-start');
    const durationInput = page.locator('#appt-duration');
    const sobreturno = page.getByRole('checkbox', { name: es.calendar.fineMode });

    // Default (unchecked): SlotPicker shown, manual entry hidden.
    await expect(sobreturno).not.toBeChecked();
    await expect(slotPickerTitle).toBeVisible();
    await expect(startInput).toHaveCount(0);
    await expect(durationInput).toHaveCount(0);

    // Checked: manual hora/duración shown, SlotPicker hidden.
    await sobreturno.check();
    await expect(sobreturno).toBeChecked();
    await expect(startInput).toBeVisible();
    await expect(durationInput).toBeVisible();
    await expect(slotPickerTitle).toHaveCount(0);

    // Unchecked again: reverts to the SlotPicker.
    await sobreturno.uncheck();
    await expect(sobreturno).not.toBeChecked();
    await expect(slotPickerTitle).toBeVisible();
    await expect(startInput).toHaveCount(0);
    await expect(durationInput).toHaveCount(0);
  });
});
