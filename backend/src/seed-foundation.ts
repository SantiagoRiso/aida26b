import dotenv from 'dotenv';
import { createOwnerPool } from './db';
import { BUSINESS_TZ } from './time';
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from '../../shared/src/dev-fixtures';
import {
  type PoolLike,
  upsertBusiness,
  upsertUser,
  upsertResource,
  upsertService,
  upsertClientPrice,
  upsertProfessionalService,
  upsertBlock,
  upsertScheduleException,
} from './seed-lib';

dotenv.config();

// Idempotent: re-running inserts nothing new. Not a migration.

const BUSINESS_NAME = 'Estudio Demo';

const WEEKLY_HOURS = {
  mon: [{ start: '09:00', end: '17:00' }],
  tue: [{ start: '09:00', end: '17:00' }],
  wed: [{ start: '09:00', end: '17:00' }],
  thu: [{ start: '09:00', end: '17:00' }],
  fri: [{ start: '09:00', end: '13:00' }],
};

const DEMO_USERS = [
  { username: DEMO_ACCOUNTS.adminUser.username,        email: 'admin@demo.test',  role: 'Admin',        displayName: 'Admin Demo' },
  { username: DEMO_ACCOUNTS.professionalUser.username, email: 'pro@demo.test',    role: 'Professional', displayName: 'Marge Bouvier', bio: 'Demo professional' },
  { username: DEMO_ACCOUNTS.receptionistWithGrant.username, email: 'recep@demo.test', role: 'Receptionist', displayName: 'Recep Demo' },
  { username: DEMO_ACCOUNTS.client.username,           email: 'client@demo.test', role: 'Client',       displayName: 'Homero Simpson', phone: '1144440000', notes: null },
] as const;

// Seeds one block per weekday. A professional block offers the given service at its default
// duration/price; a resource block offers nothing (services are professional-only).
async function seedWeeklyBlocks(
  pool: PoolLike,
  owner: { professionalUserId?: string; resourceId?: string },
  serviceId: string | null,
): Promise<void> {
  for (const [weekday, ranges] of Object.entries(WEEKLY_HOURS)) {
    for (const range of ranges) {
      const blockId = await upsertBlock(pool, owner, weekday, range.start, range.end);
      if (owner.professionalUserId && serviceId) {
        await pool.query(
          `INSERT INTO schedule_block_services (professional_user_id, schedule_block_id, service_id)
           VALUES ($1, $2, $3) ON CONFLICT (schedule_block_id, service_id) DO NOTHING`,
          [owner.professionalUserId, blockId, serviceId],
        );
      }
    }
  }
}

export async function seedFoundation(pool: PoolLike): Promise<void> {
  const businessId = await upsertBusiness(pool, BUSINESS_NAME, BUSINESS_TZ);

  const userIds: Record<string, string> = {};
  for (const user of DEMO_USERS) {
    userIds[user.role] = await upsertUser(pool, businessId, DEMO_PASSWORD, user);
  }

  // Person attributes (display_name, bio, phone, notes) live on auth.users;
  // the professional and client identifiers are the user ids directly.
  const professionalUserId = userIds.Professional;
  const clientUserId       = userIds.Client;

  const resourceId = await upsertResource(pool, businessId, 'Sala 1', 'Demo resource');
  const serviceId  = await upsertService(pool, businessId, 'Corte', 30, '1500.00', 'Demo service');

  await upsertClientPrice(pool, clientUserId, professionalUserId, serviceId, '1200.00');
  await upsertProfessionalService(pool, professionalUserId, serviceId);
  await seedWeeklyBlocks(pool, { professionalUserId }, serviceId);
  await seedWeeklyBlocks(pool, { resourceId }, null);
  await upsertScheduleException(pool, { professionalUserId }, '2026-07-09', { isUnavailable: true, reason: 'Feriado demo' });
}

async function main() {
  const pool = createOwnerPool();
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
