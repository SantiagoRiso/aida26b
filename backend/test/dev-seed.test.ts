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
    expect(await count('clients')).toBe(1);
    expect(await count('professionals')).toBe(1);
    expect(await count('resources')).toBe(1);
    expect(await count('services')).toBe(1);
    expect(await count('client_professional_services')).toBe(1);
    expect(await count('schedules')).toBe(2);
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

  it('links every client to a user and scopes direct owners to the business', async () => {
    const nullUser = await pool.query(`SELECT 1 FROM clients WHERE user_id IS NULL`);
    expect(nullUser.rows.length).toBe(0);

    const business = await pool.query<{ id: string }>(`SELECT id FROM businesses LIMIT 1`);
    const businessId = business.rows[0].id;
    for (const table of ['clients', 'professionals', 'resources', 'services']) {
      const r = await pool.query(`SELECT 1 FROM ${table} WHERE business_id <> $1`, [businessId]);
      expect(r.rows.length, `${table} business scope`).toBe(0);
    }
  });

  it('keeps schedules tied to exactly one owner with valid FKs', async () => {
    const bad = await pool.query(
      `SELECT 1 FROM schedules
       WHERE (professional_id IS NULL) = (resource_id IS NULL)`
    );
    expect(bad.rows.length).toBe(0);

    const cps = await pool.query(
      `SELECT 1 FROM client_professional_services cps
       JOIN clients c ON c.id = cps.client_id
       JOIN professionals p ON p.id = cps.professional_id
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
