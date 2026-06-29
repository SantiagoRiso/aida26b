import { Pool } from 'pg';
import dotenv from 'dotenv';
import { hashPassword } from './auth';

dotenv.config();

// Dev/demo-only foundation seed. Idempotent: re-running inserts nothing new. Not a migration.

const BUSINESS_NAME = 'Estudio Demo';
const TIMEZONE = 'America/Argentina/Buenos_Aires';

const WEEKLY_HOURS = {
  mon: [{ start: '09:00', end: '17:00' }],
  tue: [{ start: '09:00', end: '17:00' }],
  wed: [{ start: '09:00', end: '17:00' }],
  thu: [{ start: '09:00', end: '17:00' }],
  fri: [{ start: '09:00', end: '13:00' }],
};

const DEMO_USERS = [
  { username: 'demo_admin', email: 'admin@demo.test', role: 'Admin' },
  { username: 'demo_pro', email: 'pro@demo.test', role: 'Professional' },
  { username: 'demo_recep', email: 'recep@demo.test', role: 'Receptionist' },
  { username: 'demo_client', email: 'client@demo.test', role: 'Client' },
] as const;

const DEMO_PASSWORD = 'demo-pass-123';

async function pickId(
  pool: Pick<Pool, 'query'>,
  sql: string,
  params: unknown[]
): Promise<string | null> {
  const result = await pool.query<{ id: string }>(sql, params);
  return result.rows[0]?.id ?? null;
}

async function upsertBusiness(pool: Pick<Pool, 'query'>): Promise<string> {
  // Reuse the single active business if one exists (e.g. created by seed-admin); only create
  // the demo business when the database has none, so the two seeders never diverge.
  const existing = await pickId(pool, `SELECT id FROM businesses ORDER BY id LIMIT 1`, []);
  if (existing) return existing;
  return (await pickId(
    pool,
    `INSERT INTO businesses (name, timezone, currency_code) VALUES ($1, $2, 'ARS') RETURNING id`,
    [BUSINESS_NAME, TIMEZONE]
  ))!;
}

async function upsertUser(
  pool: Pick<Pool, 'query'>,
  businessId: string,
  user: { username: string; email: string; role: string }
): Promise<string> {
  const { passwordHash, passwordSalt } = await hashPassword(DEMO_PASSWORD);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO auth.users
       (username, email, password_hash, password_salt, role, business_id, is_active, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6, true, false)
     ON CONFLICT (username) DO UPDATE
       SET email = EXCLUDED.email, role = EXCLUDED.role,
           business_id = EXCLUDED.business_id, updated_at = now()
     RETURNING id`,
    [user.username, user.email, passwordHash, passwordSalt, user.role, businessId]
  );
  return result.rows[0].id;
}

async function upsertProfessional(
  pool: Pick<Pool, 'query'>,
  businessId: string,
  displayName: string,
  userId: string | null
): Promise<string> {
  const existing = await pickId(
    pool,
    `SELECT id FROM professionals WHERE business_id = $1 AND display_name = $2 LIMIT 1`,
    [businessId, displayName]
  );
  if (existing) return existing;
  return (await pickId(
    pool,
    `INSERT INTO professionals (business_id, user_id, display_name, bio) VALUES ($1, $2, $3, $4) RETURNING id`,
    [businessId, userId, displayName, 'Demo professional']
  ))!;
}

async function upsertResource(
  pool: Pick<Pool, 'query'>,
  businessId: string,
  name: string
): Promise<string> {
  const existing = await pickId(
    pool,
    `SELECT id FROM resources WHERE business_id = $1 AND name = $2 LIMIT 1`,
    [businessId, name]
  );
  if (existing) return existing;
  return (await pickId(
    pool,
    `INSERT INTO resources (business_id, name, description) VALUES ($1, $2, $3) RETURNING id`,
    [businessId, name, 'Demo resource']
  ))!;
}

async function upsertService(
  pool: Pick<Pool, 'query'>,
  businessId: string,
  name: string,
  durationMinutes: number,
  priceArs: string
): Promise<string> {
  const existing = await pickId(
    pool,
    `SELECT id FROM services WHERE business_id = $1 AND name = $2 LIMIT 1`,
    [businessId, name]
  );
  if (existing) return existing;
  return (await pickId(
    pool,
    `INSERT INTO services (business_id, name, description, default_duration_minutes, default_price_ars)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [businessId, name, 'Demo service', durationMinutes, priceArs]
  ))!;
}

async function upsertClient(
  pool: Pick<Pool, 'query'>,
  businessId: string,
  userId: string,
  displayName: string
): Promise<string> {
  // One client per linked user (clients.user_id is NOT NULL).
  const existing = await pickId(pool, `SELECT id FROM clients WHERE user_id = $1 LIMIT 1`, [userId]);
  if (existing) return existing;
  return (await pickId(
    pool,
    `INSERT INTO clients (business_id, user_id, display_name, email, phone)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [businessId, userId, displayName, 'client@demo.test', '1144440000']
  ))!;
}

async function upsertClientPrice(
  pool: Pick<Pool, 'query'>,
  clientId: string,
  professionalId: string,
  serviceId: string,
  priceArs: string
): Promise<void> {
  await pool.query(
    `INSERT INTO client_professional_services (client_id, professional_id, service_id, price_ars)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (client_id, professional_id, service_id) DO NOTHING`,
    [clientId, professionalId, serviceId, priceArs]
  );
}

async function upsertSchedule(
  pool: Pick<Pool, 'query'>,
  owner: { professionalId?: string; resourceId?: string }
): Promise<void> {
  const column = owner.professionalId ? 'professional_id' : 'resource_id';
  const ownerId = owner.professionalId ?? owner.resourceId;
  const existing = await pickId(pool, `SELECT id FROM schedules WHERE ${column} = $1 LIMIT 1`, [ownerId]);
  if (existing) return;
  await pool.query(
    `INSERT INTO schedules (${column}, weekly) VALUES ($1, $2)`,
    [ownerId, JSON.stringify(WEEKLY_HOURS)]
  );
}

async function upsertScheduleException(
  pool: Pick<Pool, 'query'>,
  professionalId: string,
  exceptionDate: string
): Promise<void> {
  const existing = await pickId(
    pool,
    `SELECT id FROM schedule_exceptions WHERE professional_id = $1 AND exception_date = $2 LIMIT 1`,
    [professionalId, exceptionDate]
  );
  if (existing) return;
  await pool.query(
    `INSERT INTO schedule_exceptions (professional_id, exception_date, is_unavailable, reason)
     VALUES ($1, $2, true, 'Feriado demo')`,
    [professionalId, exceptionDate]
  );
}

export async function seedFoundation(pool: Pick<Pool, 'query'>): Promise<void> {
  const businessId = await upsertBusiness(pool);

  const userIds: Record<string, string> = {};
  for (const user of DEMO_USERS) {
    userIds[user.role] = await upsertUser(pool, businessId, user);
  }

  const professionalId = await upsertProfessional(pool, businessId, 'Marge Bouvier', userIds.Professional);
  const resourceId = await upsertResource(pool, businessId, 'Sala 1');
  const serviceId = await upsertService(pool, businessId, 'Corte', 30, '1500.00');
  const clientId = await upsertClient(pool, businessId, userIds.Client, 'Homero Simpson');

  await upsertClientPrice(pool, clientId, professionalId, serviceId, '1200.00');
  await upsertSchedule(pool, { professionalId });
  await upsertSchedule(pool, { resourceId });
  await upsertScheduleException(pool, professionalId, '2026-07-09');
}

function makePool(): Pool {
  return new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
    // Prefer owner credentials: the app role can't write config tables like businesses.
    user: process.env.DB_OWNER_USER || process.env.DB_USER,
    password: process.env.DB_OWNER_PASSWORD || process.env.DB_PASSWORD,
  });
}

async function main() {
  const pool = makePool();
  try {
    await seedFoundation(pool);
    console.log('Foundation seed complete');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
