import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { getSelfProfile, updateSelfProfile } from '../src/db/users';

let pool: Pool;
let bizId: number;
let proId: number;

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
  const biz = await pool.query<{ id: string }>(
    `INSERT INTO businesses (name) VALUES ('Prof Profile Biz') RETURNING id`,
  );
  bizId = Number(biz.rows[0].id);
  const pro = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, phone, bio, password_hash, password_salt, role, business_id)
     VALUES ('pro_prof', 'pro_prof@x.com', 'Pro Prof', '111', 'old bio', 'h', 's', 'Professional', $1)
     RETURNING id`,
    [bizId],
  );
  proId = Number(pro.rows[0].id);
});

afterAll(async () => { await pool.end(); });

describe('self-profile db queries', () => {
  test('getSelfProfile returns the professional profile fields', async () => {
    const row = await getSelfProfile(pool, proId);
    expect(row).not.toBeNull();
    expect(row!.display_name).toBe('Pro Prof');
    expect(row!.email).toBe('pro_prof@x.com');
    expect(row!.phone).toBe('111');
    expect(row!.bio).toBe('old bio');
  });

  test('updateSelfProfile writes all four fields and returns them', async () => {
    const updated = await updateSelfProfile(pool, {
      userId: proId, displayName: 'New Name', bio: 'new bio', email: 'new@x.com', phone: '222',
    });
    expect(updated).not.toBeNull();
    expect(updated!.display_name).toBe('New Name');
    expect(updated!.email).toBe('new@x.com');
    expect(updated!.phone).toBe('222');
    expect(updated!.bio).toBe('new bio');
    const reread = await getSelfProfile(pool, proId);
    expect(reread!.email).toBe('new@x.com');
  });
});
