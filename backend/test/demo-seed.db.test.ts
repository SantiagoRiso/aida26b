import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { seedDemo } from '../src/seed-demo';
import { listVirtualOccurrences } from '../src/services/series-listing';
import { resetTestDb, makeTestPool } from './helpers';
import type { SqlParam } from '../src/db/core';
import { auditEventLabel } from '../../shared/src/ssot/domain/audit-events';

let pool: Pool;

async function count(sql: string, params: SqlParam[] = []): Promise<number> {
  const r = await pool.query<{ count: string }>(sql, params);
  return Number(r.rows[0].count);
}

// Now-relative fixture dates — never hardcode calendar dates.
function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Seeding hashes ~42 passwords (scrypt) per run and inserts a month-plus of data; two runs
// comfortably exceed the 10s default hook timeout, so widen it.
beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
  await seedDemo(pool);
  await seedDemo(pool); // twice — assertions below must hold after a re-run too
}, 60_000);

afterAll(async () => {
  await pool.end();
});

describe('demo seed feature coverage (SC4)', () => {
  it('seeds all four roles with a fuller BsAs clinic dataset', async () => {
    expect(await count(`SELECT COUNT(*)::int count FROM auth.users WHERE role = 'Admin'`)).toBeGreaterThanOrEqual(1);
    const pros = await count(`SELECT COUNT(*)::int count FROM auth.users WHERE role = 'Professional'`);
    expect(pros).toBeGreaterThanOrEqual(6);
    expect(pros).toBeLessThanOrEqual(8);
    expect(await count(`SELECT COUNT(*)::int count FROM auth.users WHERE role = 'Receptionist'`)).toBeGreaterThanOrEqual(1);
    const clients = await count(`SELECT COUNT(*)::int count FROM auth.users WHERE role = 'Client'`);
    expect(clients).toBeGreaterThanOrEqual(30);
    expect(clients).toBeLessThanOrEqual(40);
  });

  it('uses the Buenos Aires timezone and ARS currency', async () => {
    const r = await pool.query<{ timezone: string; currency_code: string }>(
      `SELECT timezone, currency_code FROM businesses LIMIT 1`,
    );
    expect(r.rows[0].timezone).toBe('America/Argentina/Buenos_Aires');
    expect(r.rows[0].currency_code.trim()).toBe('ARS');
  });

  it('seeds several room resources', async () => {
    expect(await count(`SELECT COUNT(*)::int count FROM resources`)).toBeGreaterThanOrEqual(2);
  });

  it('has per-client price overrides', async () => {
    expect(await count(`SELECT COUNT(*)::int count FROM client_professional_services`)).toBeGreaterThanOrEqual(1);
  });

  it('exactly one account is seeded must_change_password', async () => {
    expect(await count(`SELECT COUNT(*)::int count FROM auth.users WHERE must_change_password = true`)).toBe(1);
  });

  it('a receptionist holds a calendar grant', async () => {
    const n = await count(
      `SELECT COUNT(*)::int count FROM calendar_grants g
       JOIN auth.users u ON u.id = g.grantee_user_id
       WHERE u.role = 'Receptionist'`,
    );
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it('records at least one conflict override (sobreturno)', async () => {
    const n = await count(
      `SELECT COUNT(*)::int count FROM appointments
       WHERE override_conflict = true AND override_actor_id IS NOT NULL`,
    );
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it('covers requested, scheduled, completed states and at least one no_show or rejected', async () => {
    for (const state of ['requested', 'scheduled', 'completed']) {
      expect(
        await count(`SELECT COUNT(*)::int count FROM appointments WHERE state = $1`, [state]),
        `expected at least one ${state} appointment`,
      ).toBeGreaterThanOrEqual(1);
    }
    const terminal = await count(
      `SELECT COUNT(*)::int count FROM appointments WHERE state IN ('no_show', 'rejected')`,
    );
    expect(terminal).toBeGreaterThanOrEqual(1);
  });

  it('covers all four ledger entry types', async () => {
    for (const t of ['charge', 'payment', 'adjustment_debit', 'adjustment_credit']) {
      expect(
        await count(`SELECT COUNT(*)::int count FROM ledger_entries WHERE entry_type = $1`, [t]),
        `expected at least one ${t} ledger entry`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it('leaves at least one client with a positive (overdue) balance', async () => {
    const overdue = await count(
      `SELECT COUNT(*)::int count FROM (
         SELECT client_user_id,
           SUM(CASE WHEN entry_type IN ('charge','adjustment_debit') THEN amount_ars ELSE 0 END)
           - SUM(CASE WHEN entry_type IN ('payment','adjustment_credit') THEN amount_ars ELSE 0 END) AS balance
         FROM ledger_entries GROUP BY client_user_id
       ) t WHERE balance > 0`,
    );
    expect(overdue).toBeGreaterThanOrEqual(1);
  });

  it('seeds audit examples including at least one denied outcome', async () => {
    expect(await count(`SELECT COUNT(*)::int count FROM audit_events`)).toBeGreaterThanOrEqual(1);
    expect(await count(`SELECT COUNT(*)::int count FROM audit_events WHERE outcome = 'denied'`)).toBeGreaterThanOrEqual(1);
  });

  // The seed bypasses every route, so nothing stops it from inventing an event_type no writer
  // emits. auditEventLabel is the SSOT resolver for the real vocabulary (bespoke matches plus the
  // generic CRUD/appointment-state/ledger-entry composition rules), so reusing it here means this
  // test cannot drift from what the resolver itself considers real.
  it('seeds no audit event_type outside the real vocabulary', async () => {
    const r = await pool.query<{ event_type: string }>(`SELECT DISTINCT event_type FROM audit_events`);
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(auditEventLabel(row.event_type), row.event_type).not.toBeNull();
    }
  });

  // assertLedgerWriteAllowed (routes/appointment-authz.ts) forbids a Receptionist from writing a
  // ledger entry with no appointment_id; the seed bypasses that guard entirely, so this test is
  // what stops it from reintroducing a receptionist charge the app itself would reject.
  it('seeds no receptionist-authored ledger entry lacking an appointment', async () => {
    const n = await count(
      `SELECT COUNT(*)::int count FROM ledger_entries le
       JOIN auth.users u ON u.id = le.actor_user_id
       WHERE u.role = 'Receptionist' AND le.appointment_id IS NULL`,
    );
    expect(n).toBe(0);
  });

  it('seeds normalized schedule blocks; every professional block offers a service', async () => {
    expect(await count(`SELECT COUNT(*)::int count FROM schedule_blocks`)).toBeGreaterThan(0);
    // No degenerate time ranges.
    expect(await count(`SELECT COUNT(*)::int count FROM schedule_blocks WHERE end_time <= start_time`)).toBe(0);
    // Every professional-owned block offers at least one service.
    const orphanProBlocks = await count(
      `SELECT COUNT(*)::int count FROM schedule_blocks b
       WHERE b.professional_user_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM schedule_block_services s WHERE s.schedule_block_id = b.id)`,
    );
    expect(orphanProBlocks).toBe(0);
  });

  it('has at least one per-block duration/price override (split-schedule professional)', async () => {
    const overrides = await count(
      `SELECT COUNT(*)::int count FROM schedule_block_services
       WHERE duration_minutes IS NOT NULL OR price_ars IS NOT NULL`,
    );
    expect(overrides).toBeGreaterThanOrEqual(1);
  });

  it('sets a business booking window and one per-service window override', async () => {
    expect(await count(`SELECT COUNT(*)::int count FROM businesses WHERE max_booking_days IS NOT NULL`)).toBeGreaterThanOrEqual(1);
    const svcOverride = await count(
      `SELECT COUNT(*)::int count FROM professional_services
       WHERE min_booking_days IS NOT NULL OR max_booking_days IS NOT NULL`,
    );
    expect(svcOverride).toBeGreaterThanOrEqual(1);
  });

  it('seeds dated schedule exceptions (day off / holiday / one-off / changed-hours)', async () => {
    expect(await count(`SELECT COUNT(*)::int count FROM schedule_exceptions`)).toBeGreaterThanOrEqual(1);
    const changedHours = await count(
      `SELECT COUNT(*)::int count FROM schedule_exceptions
       WHERE is_unavailable = false AND granularity_minutes IS NOT NULL`,
    );
    expect(changedHours).toBeGreaterThanOrEqual(1);
  });
});

// A completed appointment always has its session charge, same invariant the real transition route
// enforces in-transaction (POST /appointments/:id/transition -> insertSessionChargeIfAbsent). The
// seed writes appointments with direct SQL, so nothing but this test stands between it and drifting
// into a state the app itself can never produce.
describe('demo seed: completed-appointment charge invariant', () => {
  it('every completed appointment has exactly one linked charge, for its own price', async () => {
    const uncharged = await count(
      `SELECT COUNT(*)::int count FROM appointments a
       WHERE a.state = 'completed'
         AND NOT EXISTS (
           SELECT 1 FROM ledger_entries le
           WHERE le.appointment_id = a.id AND le.entry_type = 'charge'
         )`,
    );
    expect(uncharged).toBe(0);

    const duplicated = await count(
      `SELECT COUNT(*)::int count FROM (
         SELECT a.id FROM appointments a
         JOIN ledger_entries le ON le.appointment_id = a.id AND le.entry_type = 'charge'
         WHERE a.state = 'completed'
         GROUP BY a.id
         HAVING COUNT(*) > 1
       ) dup`,
    );
    expect(duplicated).toBe(0);

    const mismatched = await count(
      `SELECT COUNT(*)::int count FROM appointments a
       JOIN ledger_entries le ON le.appointment_id = a.id AND le.entry_type = 'charge'
       WHERE a.state = 'completed' AND le.amount_ars != a.price`,
    );
    expect(mismatched).toBe(0);
  });

  it('no no_show appointment has a linked charge', async () => {
    const noShowCharged = await count(
      `SELECT COUNT(*)::int count FROM appointments a
       JOIN ledger_entries le ON le.appointment_id = a.id AND le.entry_type = 'charge'
       WHERE a.state = 'no_show'`,
    );
    expect(noShowCharged).toBe(0);
  });

  it('charge count from completed appointments is stable across a repeat seed run', async () => {
    const before = await count(
      `SELECT COUNT(*)::int count FROM ledger_entries WHERE entry_type = 'charge'`,
    );
    await seedDemo(pool);
    const after = await count(
      `SELECT COUNT(*)::int count FROM ledger_entries WHERE entry_type = 'charge'`,
    );
    expect(after).toBe(before);
  });
});

// settleCompletedAppointments (seed-demo.ts) pays most completed sessions at the appointment,
// mirroring real front-desk collection, while leaving a deterministic unpaid tail and never
// touching Bart (demo_client_overdue) or the curated Homero/Marge/Apu pairs.
describe('demo seed: payment settlement pass', () => {
  async function balanceFor(username: string): Promise<number> {
    const r = await pool.query<{ balance: string }>(
      `SELECT COALESCE(
         SUM(CASE WHEN le.entry_type IN ('charge','adjustment_debit') THEN le.amount_ars ELSE 0 END)
         - SUM(CASE WHEN le.entry_type IN ('payment','adjustment_credit') THEN le.amount_ars ELSE 0 END),
         0) AS balance
       FROM ledger_entries le
       JOIN auth.users u ON u.id = le.client_user_id
       WHERE u.username = $1`,
      [username],
    );
    return Number(r.rows[0].balance);
  }

  it('settles most completed appointments while leaving a visible unpaid tail', async () => {
    const totalCompleted = await count(`SELECT COUNT(*)::int count FROM appointments WHERE state = 'completed'`);
    const paidCompleted = await count(
      `SELECT COUNT(*)::int count FROM appointments a
       WHERE a.state = 'completed'
         AND EXISTS (
           SELECT 1 FROM ledger_entries p WHERE p.appointment_id = a.id AND p.entry_type = 'payment'
         )`,
    );
    // Neither "pay everything" nor "pay nothing" should pass this test.
    expect(paidCompleted).toBeGreaterThan(totalCompleted / 2);
    expect(paidCompleted).toBeLessThan(totalCompleted);
  });

  it('no appointment carries more than one linked payment', async () => {
    const overPaid = await count(
      `SELECT COUNT(*)::int count FROM (
         SELECT appointment_id FROM ledger_entries
         WHERE entry_type = 'payment' AND appointment_id IS NOT NULL
         GROUP BY appointment_id
         HAVING COUNT(*) > 1
       ) dup`,
    );
    expect(overPaid).toBe(0);
  });

  it("keeps Homero's curated account netted to zero", async () => {
    expect(await balanceFor('demo_client')).toBe(0);
  });

  // Apu's curated payment is deliberately unallocated, so the settle pass's per-appointment
  // "already has a payment" guard can't see it and would post a second payment for the same
  // charge; seed-demo.ts passes his appointment id explicitly to avoid that. The blanket "no
  // appointment has >1 linked payment" check above would not catch a regression here: the new
  // payment would be linked while Apu's stays unlinked, so neither exceeds one on its own.
  it("does not double-pay Apu's curated appointment via the settle pass", async () => {
    const appt = await pool.query<{ id: string }>(
      `SELECT a.id FROM appointments a
       JOIN auth.users u ON u.id = a.client_user_id
       WHERE u.username = 'demo_client3' AND a.state = 'completed' AND a.price = '10000.00'`,
    );
    expect(appt.rows.length).toBe(1);
    const linkedPayments = await count(
      `SELECT COUNT(*)::int count FROM ledger_entries WHERE appointment_id = $1 AND entry_type = 'payment'`,
      [appt.rows[0].id],
    );
    expect(linkedPayments).toBe(0);
  });

  it('keeps Bart (the curated overdue client) with a positive balance', async () => {
    expect(await balanceFor('demo_client_overdue')).toBeGreaterThan(0);
  });

  it('payment count from the settle pass is stable across a repeat seed run', async () => {
    const before = await count(`SELECT COUNT(*)::int count FROM ledger_entries WHERE entry_type = 'payment'`);
    await seedDemo(pool);
    const after = await count(`SELECT COUNT(*)::int count FROM ledger_entries WHERE entry_type = 'payment'`);
    expect(after).toBe(before);
  });
});

async function ownerIds(username: string): Promise<{ businessId: number; proId: number }> {
  const biz = await pool.query<{ id: string }>(`SELECT id FROM businesses LIMIT 1`);
  const pro = await pool.query<{ id: string }>(`SELECT id FROM auth.users WHERE username = $1`, [username]);
  return { businessId: Number(biz.rows[0].id), proId: Number(pro.rows[0].id) };
}

describe('demo seed recurring series', () => {
  it('seeds a weekly series for every professional, two for demo_pro', async () => {
    // 2 conflict-free series on demo_reset + 7 across the dense-filled professionals (demo_pro twice).
    expect(await count(`SELECT COUNT(*)::int count FROM appointment_series`)).toBe(9);

    // No professional is left without a series.
    const prosWithout = await count(
      `SELECT COUNT(*)::int count FROM auth.users u
        WHERE u.role = 'Professional'
          AND NOT EXISTS (SELECT 1 FROM appointment_series s WHERE s.professional_user_id = u.id)`,
    );
    expect(prosWithout).toBe(0);

    const demoProSeries = await count(
      `SELECT COUNT(*)::int count FROM appointment_series s
         JOIN auth.users u ON u.id = s.professional_user_id
        WHERE u.username = 'demo_pro'`,
    );
    expect(demoProSeries).toBe(2);
  });

  it('includes both open-ended and count-bounded series', async () => {
    expect(await count(`SELECT COUNT(*)::int count FROM appointment_series WHERE end_kind = 'open'`)).toBe(4);
    expect(await count(`SELECT COUNT(*)::int count FROM appointment_series WHERE end_kind = 'count'`)).toBe(5);
  });

  it('renders demo_reset occurrences conflict-free (that owner has no dense fill)', async () => {
    const { businessId, proId } = await ownerIds('demo_reset');
    const virtuals = await listVirtualOccurrences(pool, {
      businessId,
      roleScope: { kind: 'professional', userId: proId },
      windowStart: isoDaysFromNow(0),
      windowEnd: isoDaysFromNow(60),
    });

    expect(virtuals.length).toBeGreaterThan(0);
    expect(virtuals.every((v) => v.is_virtual)).toBe(true);
    expect(new Set(virtuals.map((v) => v.series_id)).size).toBe(2);
    expect(virtuals.every((v) => v.in_conflict === false)).toBe(true);
  });

  it('rings demo_pro occurrences that land on an existing scheduled turno', async () => {
    // Marge's calendar is ~80% filled, so at least one upcoming occurrence of her series overlaps a
    // scheduled turno — the recurring clash the calendar flags on the occurrence (and, in the list
    // endpoint, on the real turno too).
    const { businessId, proId } = await ownerIds('demo_pro');
    const virtuals = await listVirtualOccurrences(pool, {
      businessId,
      roleScope: { kind: 'professional', userId: proId },
      windowStart: isoDaysFromNow(0),
      windowEnd: isoDaysFromNow(45),
    });

    expect(virtuals.some((v) => v.in_conflict)).toBe(true);
  });
});

describe('demo seed idempotency', () => {
  it('a third run adds no new rows to any core table', async () => {
    const tables = ['businesses', 'auth.users', 'services', 'resources', 'schedule_blocks',
      'schedule_block_services', 'schedule_exceptions', 'client_professional_services',
      'calendar_grants', 'appointments', 'ledger_entries', 'audit_events', 'appointment_series'];
    const before: Record<string, number> = {};
    for (const t of tables) before[t] = await count(`SELECT COUNT(*)::int count FROM ${t}`);

    await seedDemo(pool);

    for (const t of tables) {
      const after = await count(`SELECT COUNT(*)::int count FROM ${t}`);
      expect(after, `${t} must be stable after a re-run`).toBe(before[t]);
    }
    // A full re-seed re-hashes ~42 passwords (scrypt) and re-scans the seeded window, which
    // exceeds the 5s default; widen it like the beforeAll hook above.
  }, 30_000);
});
