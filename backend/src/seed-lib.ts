import { Pool } from 'pg';
import { hashPassword } from './auth';
import type { SqlParam } from './db/core';

// Idempotent upsert primitives shared by seed-demo.ts and seed-foundation.ts. Every seed script is
// re-run-safe: existence is checked first, and inserts use ON CONFLICT DO NOTHING/UPDATE where a
// unique constraint makes that possible.

export type PoolLike = Pick<Pool, 'query'>;

export async function pickId(pool: PoolLike, sql: string, params: SqlParam[]): Promise<string | null> {
  const r = await pool.query<{ id: string }>(sql, params);
  return r.rows[0]?.id ?? null;
}

async function requireId(pool: PoolLike, sql: string, params: SqlParam[]): Promise<string> {
  const id = await pickId(pool, sql, params);
  if (id == null) throw new Error('Seed insert returned no id');
  return id;
}

// Reuses the single active business if one exists (e.g. created by seed-admin or the other
// seeder), so multiple seed scripts run against the same demo tenant instead of diverging.
export async function upsertBusiness(pool: PoolLike, name: string, timezone: string): Promise<string> {
  const existing = await pickId(pool, `SELECT id FROM businesses ORDER BY id LIMIT 1`, []);
  if (existing) return existing;
  return requireId(
    pool,
    `INSERT INTO businesses (name, timezone, currency_code) VALUES ($1, $2, 'ARS') RETURNING id`,
    [name, timezone],
  );
}

export async function upsertUser(
  pool: PoolLike,
  businessId: string,
  password: string,
  opts: {
    username: string;
    email: string;
    role: string;
    displayName: string;
    bio?: string | null;
    phone?: string | null;
    dni?: string | null;
    notes?: string | null;
    mustChangePassword?: boolean;
  },
): Promise<string> {
  const { passwordHash, passwordSalt } = await hashPassword(password);
  const r = await pool.query<{ id: string }>(
    `INSERT INTO auth.users
       (username, email, display_name, phone, dni, bio, notes,
        password_hash, password_salt, role, business_id, is_active, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, $12)
     ON CONFLICT (username) DO UPDATE
       SET email               = EXCLUDED.email,
           display_name        = EXCLUDED.display_name,
           phone               = EXCLUDED.phone,
           dni                 = EXCLUDED.dni,
           bio                 = EXCLUDED.bio,
           notes               = EXCLUDED.notes,
           role                = EXCLUDED.role,
           business_id         = EXCLUDED.business_id,
           must_change_password = EXCLUDED.must_change_password,
           updated_at          = now()
     RETURNING id`,
    [
      opts.username, opts.email, opts.displayName,
      opts.phone ?? null, opts.dni ?? null, opts.bio ?? null, opts.notes ?? null,
      passwordHash, passwordSalt, opts.role, businessId,
      opts.mustChangePassword ?? false,
    ],
  );
  return r.rows[0].id;
}

export async function upsertService(
  pool: PoolLike,
  businessId: string,
  name: string,
  durationMinutes: number,
  priceArs: string,
  description: string | null = null,
): Promise<string> {
  const existing = await pickId(
    pool,
    `SELECT id FROM services WHERE business_id = $1 AND name = $2 LIMIT 1`,
    [businessId, name],
  );
  if (existing) return existing;
  return requireId(
    pool,
    `INSERT INTO services (business_id, name, description, default_duration_minutes, default_price_ars)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [businessId, name, description, durationMinutes, priceArs],
  );
}

export async function upsertResource(
  pool: PoolLike,
  businessId: string,
  name: string,
  description: string | null = null,
): Promise<string> {
  const existing = await pickId(
    pool,
    `SELECT id FROM resources WHERE business_id = $1 AND name = $2 LIMIT 1`,
    [businessId, name],
  );
  if (existing) return existing;
  return requireId(
    pool,
    `INSERT INTO resources (business_id, name, description) VALUES ($1, $2, $3) RETURNING id`,
    [businessId, name, description],
  );
}

// Idempotent block insert keyed by (owner, weekday, start). Returns the block id so its offered
// services can be attached.
export async function upsertBlock(
  pool: PoolLike,
  owner: { professionalUserId?: string; resourceId?: string },
  weekday: string,
  start: string,
  end: string,
): Promise<string> {
  const col = owner.professionalUserId ? 'professional_user_id' : 'resource_id';
  const id = owner.professionalUserId ?? owner.resourceId ?? null;
  const existing = await pickId(
    pool,
    `SELECT id FROM schedule_blocks WHERE ${col} = $1 AND weekday = $2 AND start_time = $3::time LIMIT 1`,
    [id, weekday, start],
  );
  if (existing) return existing;
  return requireId(
    pool,
    `INSERT INTO schedule_blocks (${col}, weekday, start_time, end_time)
     VALUES ($1, $2, $3::time, $4::time) RETURNING id`,
    [id, weekday, start, end],
  );
}

export async function upsertClientPrice(
  pool: PoolLike,
  clientUserId: string,
  professionalUserId: string,
  serviceId: string,
  priceArs: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO client_professional_services (client_user_id, professional_user_id, service_id, price_ars)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (client_user_id, professional_user_id, service_id) DO NOTHING`,
    [clientUserId, professionalUserId, serviceId, priceArs],
  );
}

export async function upsertProfessionalService(
  pool: PoolLike,
  professionalUserId: string,
  serviceId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO professional_services (professional_user_id, service_id)
     VALUES ($1, $2) ON CONFLICT (professional_user_id, service_id) DO NOTHING`,
    [professionalUserId, serviceId],
  );
}

export async function upsertScheduleException(
  pool: PoolLike,
  owner: { professionalUserId?: string; resourceId?: string },
  date: string,
  opts: { isUnavailable: boolean; reason?: string; startTime?: string; endTime?: string; granularityMinutes?: number },
): Promise<void> {
  const col = owner.professionalUserId ? 'professional_user_id' : 'resource_id';
  const id = owner.professionalUserId ?? owner.resourceId ?? null;
  const existing = await pickId(
    pool,
    `SELECT id FROM schedule_exceptions WHERE ${col} = $1 AND exception_date = $2`,
    [id, date],
  );
  if (existing) return;
  await pool.query(
    `INSERT INTO schedule_exceptions (${col}, exception_date, is_unavailable, reason, start_time, end_time, granularity_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, date, opts.isUnavailable, opts.reason ?? null, opts.startTime ?? null, opts.endTime ?? null, opts.granularityMinutes ?? null],
  );
}
