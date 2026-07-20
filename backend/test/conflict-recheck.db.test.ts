import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { recheckConflictsInTx } from '../src/services/scheduling';

// Concurrency proof driven directly against recheckConflictsInTx. No appointment is written
// (a recheck is read-only) — the invariant is proven at the advisory-lock level.
let pool: Pool;
let bizId: number;
let pro1: number;
let pro2: number;
const MONDAY = '2026-06-29';
let serviceId: number;

async function seedPro(username: string): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ($1, $2, $3, 'h', 's', 'Professional', $4, false) RETURNING id`,
    [username, `${username}@test.local`, username, bizId]
  );
  const id = Number(r.rows[0].id);
  const block = await pool.query<{ id: string }>(
    `INSERT INTO schedule_blocks (professional_user_id, weekday, start_time, end_time)
     VALUES ($1, 'mon', '09:00', '12:00') RETURNING id`,
    [id]
  );
  await pool.query(
    `INSERT INTO schedule_block_services (professional_user_id, schedule_block_id, service_id)
     VALUES ($1, $2, $3)`,
    [id, block.rows[0].id, serviceId]
  );
  return id;
}

const proposal = (professionalUserId: number) => ({
  businessId: bizId,
  professionalUserId,
  date: MONDAY,
  start: '09:00',
  durationMinutes: 15,
  serviceId,
  callerIsStaff: true,
});

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const biz = await pool.query<{ id: string }>(`INSERT INTO businesses (name) VALUES ('Recheck Biz') RETURNING id`);
  bizId = Number(biz.rows[0].id);

  const svc = await pool.query<{ id: string }>(
    `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
     VALUES ($1, 'Consulta', 15, '1000.00') RETURNING id`,
    [bizId]
  );
  serviceId = Number(svc.rows[0].id);

  pro1 = await seedPro('recheck_pro1');
  pro2 = await seedPro('recheck_pro2');
});

afterAll(async () => {
  await pool.end();
});

describe('recheckConflictsInTx — advisory-locked transactional recheck', () => {
  test('same-owner rechecks serialize on the per-owner advisory lock', async () => {
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    const order: string[] = [];
    try {
      await c1.query('BEGIN');
      const v1 = await recheckConflictsInTx(c1, proposal(pro1));
      expect(v1.can_save).toBe(true);
      order.push('c1-evaluated');

      await c2.query('BEGIN');
      // c2 requests the SAME owner lock — it blocks inside recheckConflictsInTx until c1 commits.
      const c2done = recheckConflictsInTx(c2, proposal(pro1)).then((v) => {
        order.push('c2-evaluated');
        return v;
      });

      await new Promise((r) => setTimeout(r, 200)); // let c2 reach and block on the lock
      order.push('c1-commit');
      await c1.query('COMMIT');

      const v2 = await c2done;
      await c2.query('COMMIT');

      // c2 evaluated only AFTER c1 committed → the two same-owner rechecks were serialized.
      expect(order).toEqual(['c1-evaluated', 'c1-commit', 'c2-evaluated']);
      expect(v2.can_save).toBe(true); // still free: a recheck never writes, so no state changed
    } finally {
      c1.release();
      c2.release();
    }
  });

  test('different-owner rechecks acquire independent locks and do not block each other', async () => {
    const c1 = await pool.connect();
    const c3 = await pool.connect();
    try {
      await c1.query('BEGIN');
      await recheckConflictsInTx(c1, proposal(pro1));

      await c3.query('BEGIN');
      const outcome = await Promise.race([
        recheckConflictsInTx(c3, proposal(pro2)).then(() => 'evaluated' as const),
        new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 1500)),
      ]);
      expect(outcome).toBe('evaluated'); // pro2's lock is a different key → no wait on pro1
      await c3.query('COMMIT');
      await c1.query('COMMIT');
    } finally {
      c1.release();
      c3.release();
    }
  });
});
