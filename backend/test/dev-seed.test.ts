import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { seedFoundation } from '../src/seed-foundation';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';

let pool: Pool;

async function count(table: string): Promise<number> {
  const r = await pool.query<{ count: string }>(`SELECT COUNT(*)::int AS count FROM ${table}`);
  return Number(r.rows[0].count);
}

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  // Run twice to prove idempotency: the second run must insert nothing new.
  await seedFoundation(pool);
  await seedFoundation(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('foundation seed', () => {
  it('is idempotent (no duplicate rows after a second run)', async () => {
    expect(await count('businesses')).toBe(1);
    expect(await count('auth.users')).toBe(4);
    expect(await count('resources')).toBe(1);
    expect(await count('services')).toBe(1);
    expect(await count('client_professional_services')).toBe(1);
    // One block per weekday for the professional (5) and the resource (5).
    expect(await count('schedule_blocks')).toBe(10);
    // Each professional block offers the single seeded service; resource blocks offer none.
    expect(await count('schedule_block_services')).toBe(5);
    expect(await count('schedule_exceptions')).toBe(1);
  });

  it('seeds one business with Argentina timezone and ARS currency', async () => {
    const r = await pool.query(`SELECT timezone, currency_code FROM businesses`);
    expect(r.rows[0].timezone).toBe('America/Argentina/Buenos_Aires');
    expect(r.rows[0].currency_code).toBe('ARS');
  });

  it('seeds representative users across the four roles', async () => {
    const r = await pool.query<{ role: string }>(`SELECT role FROM auth.users ORDER BY role`);
    const roles = r.rows.map((row) => row.role).sort();
    expect(roles).toEqual(['Admin', 'Client', 'Professional', 'Receptionist']);
  });

  it('all users have a display_name (NOT NULL column)', async () => {
    const missing = await pool.query(`SELECT 1 FROM auth.users WHERE display_name IS NULL OR display_name = ''`);
    expect(missing.rows.length).toBe(0);
  });

  it('professional user has bio set; client user has phone set', async () => {
    const pro = await pool.query<{ bio: string | null }>(
      `SELECT bio FROM auth.users WHERE role = 'Professional' LIMIT 1`
    );
    expect(pro.rows[0]?.bio).not.toBeNull();

    const client = await pool.query<{ phone: string | null }>(
      `SELECT phone FROM auth.users WHERE role = 'Client' LIMIT 1`
    );
    expect(client.rows[0]?.phone).not.toBeNull();
  });

  it('links every user to a business; business scoped through auth.users', async () => {
    const business = await pool.query<{ id: string }>(`SELECT id FROM businesses LIMIT 1`);
    const businessId = business.rows[0].id;

    const wrongBiz = await pool.query(
      `SELECT 1 FROM auth.users WHERE business_id IS NULL OR business_id <> $1`,
      [businessId]
    );
    expect(wrongBiz.rows.length, 'all seeded users must belong to the demo business').toBe(0);

    for (const table of ['resources', 'services']) {
      const r = await pool.query(`SELECT 1 FROM ${table} WHERE business_id <> $1`, [businessId]);
      expect(r.rows.length, `${table} business scope`).toBe(0);
    }
  });

  it('keeps schedule blocks tied to exactly one owner with valid FKs', async () => {
    const bad = await pool.query(
      `SELECT 1 FROM schedule_blocks
       WHERE (professional_user_id IS NULL) = (resource_id IS NULL)`
    );
    expect(bad.rows.length).toBe(0);

    const cps = await pool.query(
      `SELECT 1 FROM client_professional_services cps
       JOIN auth.users cu ON cu.id = cps.client_user_id
       JOIN auth.users pu ON pu.id = cps.professional_user_id
       JOIN services s ON s.id = cps.service_id`
    );
    expect(cps.rows.length).toBe(1);
  });

  it('does not seed appointment, ledger_entries, or audit_events demo rows', async () => {
    expect(await count('appointments')).toBe(0);
    expect(await count('ledger_entries')).toBe(0);
    expect(await count('audit_events')).toBe(0);
  });
});
