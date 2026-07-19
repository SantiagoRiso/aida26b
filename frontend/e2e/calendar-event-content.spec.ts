import { test, expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import {
  login, DEMO_ACCOUNTS, findProfessionalId, findServiceId, findClientId,
  scheduleViaApi, navigateCalendarToAppointment, isoDaysFromNow, es,
} from './helpers';
import { DEMO_SERVICE_NAMES } from '../../shared/src/dev-fixtures';
import { weekdayOf } from '../../shared/src/ssot/domain/availability';

/**
 * Content assertions for the rendered calendar event markup (useFullCalendar.ts eventContent) —
 * not geometry: the repeat icon shows up only on virtual (recurring, un-materialized) occurrences,
 * the title is present, and the time renders as HH:MM. listVirtualOccurrences always emits an
 * occurrence for every date the recurrence rule produces (an out-of-grid day only flags
 * in_conflict, never suppresses it — see series-listing.ts), so the seeded window doesn't need to
 * land on a working weekday, just be free of other specs' fixtures.
 *
 * Uses Dr. Ned Flanders (demo_pro2) — appointment-create.spec.ts is the only other spec touching
 * him, and only through the live form on a future shiftSeedDate, never at an isoDaysFromNow-anchored
 * date — with two clients no other spec references (Selma Bouvier / Patty Bouvier), in the same
 * pre-dense-seed-window slot recurrence.spec.ts uses (isoDaysFromNow(-6)).
 */
const PRO_NAME = 'Dr. Ned Flanders';
const REAL_CLIENT_NAME = 'Selma Bouvier';
const SERIES_CLIENT_NAME = 'Patty Bouvier';
const REAL_START = '09:00';
const SERIES_START = '10:00';
const SERIES_COUNT = 3;

// Navigates to the calendar and clicks next/prev until the given event testid key
// (`<id>` for a real appointment, `virtual:<seriesId>:<date>` for a recurring occurrence) is
// visible, mirroring recurrence.spec.ts's navigateToOccurrence via the shared helper.
async function navigateToEvent(page: Page, key: string | number, direction: 'next' | 'prev' = 'next'): Promise<Locator> {
  await page.getByRole('link', { name: es.nav.calendar }).click();
  await expect(page.locator('.fc')).toBeVisible({ timeout: 10_000 });
  await navigateCalendarToAppointment(page, key, 12, direction);
  return page.locator(`[data-testid="appt-${key}"]`).first();
}

test.describe('Calendar event content (staff)', () => {
  let realId: number;
  let seriesId: number;
  let seriesDate: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const admin = await ctx.newPage();
    await login(admin, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    const professional_user_id = await findProfessionalId(admin, PRO_NAME);
    const service_id = await findServiceId(admin, DEMO_SERVICE_NAMES.sesion);
    const [realClientId, seriesClientId] = await Promise.all([
      findClientId(admin, REAL_CLIENT_NAME),
      findClientId(admin, SERIES_CLIENT_NAME),
    ]);

    // Before the dense demo-seed window (see helpers.ts isoDaysFromNow) — guaranteed conflict-free.
    const date = isoDaysFromNow(-6);

    realId = await scheduleViaApi(admin, {
      professional_user_id, service_id, client_user_id: realClientId,
      date, start: REAL_START, duration_minutes: 50, name: 'E2E contenido real',
    });

    const seriesRes = await admin.request.post('/api/appointments/series', {
      data: {
        client_user_id: seriesClientId,
        professional_user_id,
        service_id,
        frequency: 'weekly',
        interval: 1,
        weekday: weekdayOf(date),
        start_time: SERIES_START,
        start_date: date,
        duration_minutes: 50,
        end_kind: 'count',
        end_count: SERIES_COUNT,
      },
    });
    const seriesBody = await seriesRes.json();
    if (!seriesRes.ok() || !seriesBody.data?.series?.id) {
      throw new Error(`series fixture failed: ${seriesRes.status()} ${JSON.stringify(seriesBody)}`);
    }
    seriesId = Number(seriesBody.data.series.id);
    seriesDate = seriesBody.data.series.start_date; // server-confirmed anchor date

    await ctx.close();
  });

  test('a recurring occurrence shows the repeat icon, an HH:MM time, and the client title', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    const occ = await navigateToEvent(page, `virtual:${seriesId}:${seriesDate}`, 'prev');
    await expect(occ).toHaveClass(/fc-virtual-occurrence/);

    // The recurring cue is a bottom-right corner badge (::after) masked from the Material repeat
    // SVG — the same spot/mechanism as the sobreturno clock. Assert the pseudo-element's mask image.
    const repeatBadge = await occ.evaluate((el) => {
      const s = getComputedStyle(el, '::after');
      return s.maskImage !== 'none' && s.maskImage ? s.maskImage : s.webkitMaskImage;
    });
    expect(repeatBadge).toContain('repeat.svg');

    const time = occ.locator('.fc-ev-time');
    await expect(time).toBeVisible();
    await expect(time).toHaveText(/^\d{1,2}:\d{2}$/);
    await expect(time).toHaveText(SERIES_START);

    const title = occ.locator('.fc-ev-title');
    await expect(title).toBeVisible();
    await expect(title).toContainText(SERIES_CLIENT_NAME);
  });

  test('a real appointment shows an HH:MM time and the client title, with no repeat icon', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    const occ = await navigateToEvent(page, realId, 'prev');
    await expect(occ).not.toHaveClass(/fc-virtual-occurrence/);
    // A real turno never carries the recurring (repeat) badge — that is the whole cue. It MAY carry
    // the sobreturno alarm badge depending on where the seeded slot lands, so assert specifically
    // that the corner badge is not the repeat icon, not that no badge exists at all.
    const badge = await occ.evaluate((el) => {
      const s = getComputedStyle(el, '::after');
      return (s.maskImage !== 'none' && s.maskImage ? s.maskImage : s.webkitMaskImage) || 'none';
    });
    expect(badge).not.toContain('repeat.svg');

    const time = occ.locator('.fc-ev-time');
    await expect(time).toBeVisible();
    await expect(time).toHaveText(/^\d{1,2}:\d{2}$/);
    await expect(time).toHaveText(REAL_START);

    const title = occ.locator('.fc-ev-title');
    await expect(title).toBeVisible();
    await expect(title).toContainText(REAL_CLIENT_NAME);
  });
});
