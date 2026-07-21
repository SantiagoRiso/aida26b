import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { login, DEMO_ACCOUNTS, es } from './helpers';

/**
 * Cancellation cutoff is 24h before start.
 *
 * The seed's fixed calendar dates drift out of the cutoff window as real time passes,
 * so this spec creates its OWN two deterministic appointments via the real staff API
 * rather than relying on seed timing:
 *   - one starting ~3h from now  → WITHIN the 24h cutoff → cancel must be blocked + 422.
 *   - one starting ~72h from now → BEFORE the cutoff      → cancel must succeed.
 */

interface CreatedAppt { id: number; startsAt: string }

// Mirrors frontend/src/composables/useCurrency.ts DATETIME_FORMATTER. That formatter takes no
// explicit timeZone, so it renders in whatever timezone is the runtime default — the same default
// the Playwright-driven browser and this Node test process share on a given machine. Duplicated
// here (not imported) for the same reason helpers.ts mirrors STATE_LABELS_ES: the e2e/ directory
// is pinned to commonjs and can't load frontend/src's Vite-aliased ESM modules.
const DATETIME_FORMATTER = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});

async function scheduleAt(page: Page, hoursFromNow: number, name: string): Promise<CreatedAppt> {
  const profRes = await page.request.get('/api/professionals');
  const profBody = await profRes.json();
  const prof = profBody.data.find((p: { display_name: string }) => p.display_name === 'Dra. Marge Bouvier');

  const svcRes = await page.request.get('/api/services');
  const svcBody = await svcRes.json();
  const svc = svcBody.data.find((s: { name: string }) => s.name === 'Sesión de Psicología Infantil');

  const clientsRes = await page.request.get(`/api/clients?filter_display_name=${encodeURIComponent('Homero Simpson')}`);
  const clientsBody = await clientsRes.json();
  const client = clientsBody.data[0];

  // Use the runner's LOCAL wall-clock consistently for both date and time (not a mix of
  // UTC-based toISOString + local getHours) — the backend interprets date+start in the
  // business timezone (America/Argentina/Buenos_Aires), so an exact UTC offset match isn't
  // achievable from an arbitrary runner locale anyway. The 3h/72h deltas chosen by callers
  // are far enough from the 24h cutoff boundary to absorb any reasonable timezone skew.
  const startAt = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
  // An appointment may not run past midnight, so a start whose duration would spill into the next
  // day is pushed forward to that day's 00:00 instead. Only the distance from now matters to the
  // cutoff, and the push is under an hour, so both fixtures stay on their intended side of the 24h
  // boundary — which keeps the spec deterministic in the late evening, not just during the day.
  const endsAt = new Date(startAt.getTime() + svc.default_duration_minutes * 60 * 1000);
  if (endsAt.getDate() !== startAt.getDate()) startAt.setHours(24, 0, 0, 0);
  const date = `${startAt.getFullYear()}-${String(startAt.getMonth() + 1).padStart(2, '0')}-${String(startAt.getDate()).padStart(2, '0')}`;
  const start = `${String(startAt.getHours()).padStart(2, '0')}:${String(startAt.getMinutes()).padStart(2, '0')}`;

  const scheduleRes = await page.request.post('/api/appointments/schedule', {
    data: {
      // Fixed pre-existing bug: /api/professionals and /api/clients expose the
      // user's row under `id`, not `user_id` — the field this fixture originally
      // read never existed, so professional_user_id/client_user_id both silently
      // resolved to `undefined` and were dropped by JSON.stringify. That triggers
      // a REAL backend bug independently found while writing this suite: the
      // appointments table has client_user_id NOT NULL, but /appointments/schedule
      // never validates it's present before the INSERT — the resulting Postgres
      // error is unhandled and crashes the entire Node process.
      professional_user_id: prof.id,
      service_id: svc.id,
      client_user_id: client.id,
      date,
      start,
      duration_minutes: svc.default_duration_minutes,
      name,
      // Bypass any incidental conflict with other fixtures — this spec tests the
      // cutoff gate, not the conflict-detection gate.
      override: true,
    },
  });
  const body = await scheduleRes.json();
  if (!scheduleRes.ok() || !body.data?.id) {
    throw new Error(`Failed to create fixture appointment "${name}": ${scheduleRes.status()} ${JSON.stringify(body)}`);
  }
  // Use the server's authoritative starts_at (not the naive local `startAt` built above) — the
  // backend interprets date+start in the business timezone, so only the persisted value is
  // guaranteed to match what AppointmentsView.vue actually renders.
  return { id: Number(body.data.id), startsAt: body.data.starts_at };
}

test.describe('Client cancel — cutoff boundary', () => {
  let withinCutoffApptId: number;
  let beforeCutoffApptId: number;
  let withinCutoffLabel: string;
  let beforeCutoffLabel: string;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, DEMO_ACCOUNTS.adminUser.username, DEMO_ACCOUNTS.adminUser.password);

    const within = await scheduleAt(page, 3, 'Turno cutoff E2E — dentro del plazo');
    const before = await scheduleAt(page, 72, 'Turno cutoff E2E — antes del plazo');
    withinCutoffApptId = within.id;
    beforeCutoffApptId = before.id;
    // The appointment `name` fixture value isn't a reliable locator: AppointmentsView.vue's
    // history/past list items don't render `appt.name` at all (only the upcoming items do), and a
    // fixed literal name is prone to matching stale rows left by earlier runs on this shared,
    // non-reset server. The rendered date/time text is present in both sections and, being tied to
    // this run's wall-clock, is effectively unique per run.
    withinCutoffLabel = DATETIME_FORMATTER.format(new Date(within.startsAt));
    beforeCutoffLabel = DATETIME_FORMATTER.format(new Date(before.startsAt));

    await context.close();
  });

  test('past-cutoff scheduled appointment shows disabled Cancelar with visible explanation', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.client.username, DEMO_ACCOUNTS.client.password);
    await page.getByRole('link', { name: es.nav.myAppointments }).click();

    const row = page.locator('li').filter({ hasText: withinCutoffLabel }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });

    const alert = row.getByRole('alert');
    await expect(alert).toContainText('Venció el plazo para cancelar este turno');

    const disabledBtn = row.getByRole('button', { name: es.actions.cancel });
    await expect(disabledBtn).toBeDisabled();
  });

  test('direct cancel attempt on a past-cutoff appointment returns 422 outside_cutoff — not silent', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.client.username, DEMO_ACCOUNTS.client.password);

    // Bypass the UI entirely — prove the backend itself is the authoritative gate,
    // not just that the button happens to be disabled.
    const res = await page.request.post(`/api/appointments/${withinCutoffApptId}/transition`, {
      data: { to: 'canceled' },
    });
    expect(res.status()).toBe(422);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('outside_cutoff');
  });

  test('before-cutoff scheduled appointment can be canceled and becomes Cancelado', async ({ page }) => {
    await login(page, DEMO_ACCOUNTS.client.username, DEMO_ACCOUNTS.client.password);
    await page.getByRole('link', { name: es.nav.myAppointments }).click();

    const row = page.locator('li').filter({ hasText: beforeCutoffLabel }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });

    const cancelBtn = row.getByRole('button', { name: es.actions.cancel });
    await expect(cancelBtn).toBeEnabled();
    await cancelBtn.click();

    const confirmBtn = page.getByRole('button', { name: es.portal.cancelAppointment });
    await expect(confirmBtn).toBeVisible({ timeout: 5_000 });

    // Wait for the UI-triggered transition to actually complete before firing a second,
    // independent request — otherwise the two POSTs race and the "second" call can
    // become the real first cancel (pre-existing race in this fixture, fixed here).
    const uiCancelResponse = page.waitForResponse(
      (r) => r.url().includes(`/appointments/${beforeCutoffApptId}/transition`) && r.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await confirmBtn.click();
    const uiCancelResp = await uiCancelResponse;
    expect(uiCancelResp.status()).toBe(200);

    // A second cancel attempt must be rejected as an invalid transition, which
    // independently proves the first cancel actually persisted server-side.
    const check = await page.request.post(`/api/appointments/${beforeCutoffApptId}/transition`, {
      data: { to: 'canceled' },
    });
    expect(check.status()).toBe(422);
    const checkBody = await check.json();
    expect(checkBody.error.code).toBe('invalid_transition');
  });
});
