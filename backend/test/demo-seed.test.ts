import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { seedDemo } from '../src/seed-demo';
import { resetTestDb, makeTestPool } from './helpers';
import type { SqlParam } from '../src/db/core';

let pool: Pool;

async function count(sql: string, params: SqlParam[] = []): Promise<number> {
  const r = await pool.query<{ count: string }>(sql, params);
  return Number(r.rows[0].count);
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

describe('demo seed idempotency', () => {
  it('a third run adds no new rows to any core table', async () => {
    const tables = ['businesses', 'auth.users', 'services', 'resources', 'schedule_blocks',
      'schedule_block_services', 'schedule_exceptions', 'client_professional_services',
      'calendar_grants', 'appointments', 'ledger_entries', 'audit_events'];
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
