import { Pool } from 'pg';
import dotenv from 'dotenv';
import { createOwnerPool } from './db';
import { hashPassword } from './auth';
import { validateWeeklySchedule } from '../../shared/src/ssot/domain/scheduling';

dotenv.config();

// Demo/local-only BsAs clinic seed. Idempotent: re-running adds nothing.
// Passwords are stored hashed; the plaintext only appears here as demo tooling.

const BUSINESS_NAME = 'Consultorio BsAs Demo';
const TIMEZONE = 'America/Argentina/Buenos_Aires';
const DEMO_PASSWORD = 'demo-pass-123';

// Each block length must be a whole multiple of its granularity_minutes,
// or validateWeeklySchedule rejects it — hence the non-round end times.
function weeklyFullTime50() {
  return {
    mon: [{ start: '09:00', end: '17:20', granularity_minutes: 50 }],
    tue: [{ start: '09:00', end: '17:20', granularity_minutes: 50 }],
    wed: [{ start: '09:00', end: '17:20', granularity_minutes: 50 }],
    thu: [{ start: '09:00', end: '17:20', granularity_minutes: 50 }],
    fri: [{ start: '09:00', end: '14:00', granularity_minutes: 50 }],
  };
}

function weeklyMorning30() {
  return {
    mon: [{ start: '08:00', end: '13:00', granularity_minutes: 30 }],
    tue: [{ start: '08:00', end: '13:00', granularity_minutes: 30 }],
    wed: [{ start: '08:00', end: '13:00', granularity_minutes: 30 }],
    thu: [{ start: '08:00', end: '13:00', granularity_minutes: 30 }],
    fri: [{ start: '08:00', end: '12:00', granularity_minutes: 30 }],
  };
}

function weeklyMorning40() {
  return {
    mon: [{ start: '08:00', end: '12:40', granularity_minutes: 40 }],
    tue: [{ start: '08:00', end: '12:40', granularity_minutes: 40 }],
    wed: [{ start: '08:00', end: '12:40', granularity_minutes: 40 }],
    thu: [{ start: '08:00', end: '12:40', granularity_minutes: 40 }],
    fri: [{ start: '08:00', end: '12:00', granularity_minutes: 40 }],
  };
}

// 60-min afternoon slots — matches the kinesiología service duration so appointments tile the grid.
function weeklyAfternoon60() {
  return {
    mon: [{ start: '14:00', end: '20:00', granularity_minutes: 60 }],
    tue: [{ start: '14:00', end: '20:00', granularity_minutes: 60 }],
    wed: [{ start: '14:00', end: '20:00', granularity_minutes: 60 }],
    thu: [{ start: '14:00', end: '20:00', granularity_minutes: 60 }],
  };
}

function weeklyRoom() {
  return {
    mon: [{ start: '08:00', end: '20:00', granularity_minutes: 30 }],
    tue: [{ start: '08:00', end: '20:00', granularity_minutes: 30 }],
    wed: [{ start: '08:00', end: '20:00', granularity_minutes: 30 }],
    thu: [{ start: '08:00', end: '20:00', granularity_minutes: 30 }],
    fri: [{ start: '08:00', end: '17:00', granularity_minutes: 30 }],
  };
}

// Dense appointment seeding covers SEED_DAYS from the anchor Monday, so the calendar stays
// populated well past the current week. Anchored to July 2026 to line up with the hardcoded
// schedules and the 9-de-Julio holiday exception; deterministic regardless of when the seed runs.
const SEED_START = '2026-07-06'; // Monday of the demo "current" week
const SEED_DAYS = 45;

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

// Expands the seeding window into concrete dates tagged with their weekday key.
function seedDays(): { date: string; key: string }[] {
  const [y, m, d] = SEED_START.split('-').map(Number);
  const out: { date: string; key: string }[] = [];
  for (let i = 0; i < SEED_DAYS; i++) {
    const dt = new Date(y, m - 1, d + i);
    out.push({
      date: `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`,
      key: WEEKDAY_KEYS[dt.getDay()],
    });
  }
  return out;
}

type WeeklyBlock = { start: string; end: string; granularity_minutes: number };

function hmToMin(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}
function minToHm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

// Fixed slot starts for a block, stepping by its granularity (mirrors the availability engine).
function slotStartTimes(block: WeeklyBlock): string[] {
  const out: string[] = [];
  const end = hmToMin(block.end);
  for (let t = hmToMin(block.start); t + block.granularity_minutes <= end; t += block.granularity_minutes) {
    out.push(minToHm(t));
  }
  return out;
}

// All professional + resource usernames/emails live here so the README and helpers.ts
// can align exact usernames without inspecting the DB.
const STAFF_USERS = [
  { username: 'demo_admin',  email: 'admin@demo.test',   role: 'Admin',        displayName: 'Admin Demo',             bio: null,                phone: null },
  { username: 'demo_pro',    email: 'pro@demo.test',     role: 'Professional', displayName: 'Dra. Marge Bouvier',     bio: 'Psicóloga clínica', phone: null },
  { username: 'demo_pro2',   email: 'pro2@demo.test',    role: 'Professional', displayName: 'Dr. Ned Flanders',       bio: 'Psicólogo infantil', phone: null },
  { username: 'demo_pro3',   email: 'pro3@demo.test',    role: 'Professional', displayName: 'Dra. Lisa Simpson',      bio: 'Nutricionista',     phone: null },
  { username: 'demo_pro4',   email: 'pro4@demo.test',    role: 'Professional', displayName: 'Dr. Nick Riviera',       bio: 'Kinesiólogo',       phone: null },
  { username: 'demo_pro5',   email: 'pro5@demo.test',    role: 'Professional', displayName: 'Dra. Edna Krabappel',    bio: 'Psicóloga cognitiva', phone: null },
  { username: 'demo_pro6',   email: 'pro6@demo.test',    role: 'Professional', displayName: 'Dr. Julius Hibbert',     bio: 'Médico clínico',    phone: null },
  { username: 'demo_reset',  email: 'reset@demo.test',   role: 'Professional', displayName: 'Dr. Arnie Pye',          bio: 'Psicólogo en capacitación', phone: null },
  { username: 'demo_recep',  email: 'recep@demo.test',   role: 'Receptionist', displayName: 'Recepcionista Demo',     bio: null,                phone: null },
  { username: 'demo_recep2', email: 'recep2@demo.test',  role: 'Receptionist', displayName: 'Barney Gumble',          bio: null,                phone: null },
] as const;

const CLIENT_USERS = [
  { username: 'demo_client',         email: 'client@demo.test',        displayName: 'Homero Simpson',      phone: '1144440000', notes: null },
  { username: 'demo_client_overdue', email: 'overdue@demo.test',       displayName: 'Bart Simpson',        phone: '1144440001', notes: 'Tiene saldo pendiente' },
  { username: 'demo_client2',        email: 'client2@demo.test',       displayName: 'Marge Simpson',       phone: '1144440002', notes: null },
  { username: 'demo_client3',        email: 'client3@demo.test',       displayName: 'Apu Nahasapeemapetilon', phone: '1144440003', notes: null },
  { username: 'demo_client4',        email: 'client4@demo.test',       displayName: 'Lenny Leonard',       phone: '1144440004', notes: null },
  { username: 'demo_client5',        email: 'client5@demo.test',       displayName: 'Carl Carlson',        phone: '1144440005', notes: null },
  { username: 'demo_client6',        email: 'client6@demo.test',       displayName: 'Selma Bouvier',       phone: '1144440006', notes: null },
  { username: 'demo_client7',        email: 'client7@demo.test',       displayName: 'Patty Bouvier',       phone: '1144440007', notes: null },
  { username: 'demo_client8',        email: 'client8@demo.test',       displayName: 'Seymour Skinner',     phone: '1144440008', notes: null },
  { username: 'demo_client9',        email: 'client9@demo.test',       displayName: 'Nelson Muntz',        phone: '1144440009', notes: null },
  { username: 'demo_client10',       email: 'client10@demo.test',      displayName: 'Milhouse Van Houten', phone: '1144440010', notes: null },
  { username: 'demo_client11',       email: 'client11@demo.test',      displayName: 'Ralph Wiggum',        phone: '1144440011', notes: null },
  { username: 'demo_client12',       email: 'client12@demo.test',      displayName: 'Chief Wiggum',        phone: '1144440012', notes: null },
  { username: 'demo_client13',       email: 'client13@demo.test',      displayName: 'Sideshow Bob',        phone: '1144440013', notes: null },
  { username: 'demo_client14',       email: 'client14@demo.test',      displayName: 'Krusty Clown',        phone: '1144440014', notes: null },
  { username: 'demo_client15',       email: 'client15@demo.test',      displayName: 'Snake Jailbird',      phone: '1144440015', notes: null },
  { username: 'demo_client16',       email: 'client16@demo.test',      displayName: 'Kent Brockman',       phone: '1144440016', notes: null },
  { username: 'demo_client17',       email: 'client17@demo.test',      displayName: 'Troy McClure',        phone: '1144440017', notes: null },
  { username: 'demo_client18',       email: 'client18@demo.test',      displayName: 'Otto Mann',           phone: '1144440018', notes: null },
  { username: 'demo_client19',       email: 'client19@demo.test',      displayName: 'Hans Moleman',        phone: '1144440019', notes: null },
  { username: 'demo_client20',       email: 'client20@demo.test',      displayName: 'Professor Frink',     phone: '1144440020', notes: null },
  { username: 'demo_client21',       email: 'client21@demo.test',      displayName: 'Sideshow Mel',        phone: '1144440021', notes: null },
  { username: 'demo_client22',       email: 'client22@demo.test',      displayName: 'Groundskeeper Willie', phone: '1144440022', notes: null },
  { username: 'demo_client23',       email: 'client23@demo.test',      displayName: 'Fat Tony',            phone: '1144440023', notes: null },
  { username: 'demo_client24',       email: 'client24@demo.test',      displayName: 'Cletus Spuckler',     phone: '1144440024', notes: null },
  { username: 'demo_client25',       email: 'client25@demo.test',      displayName: 'Reverend Lovejoy',    phone: '1144440025', notes: null },
  { username: 'demo_client26',       email: 'client26@demo.test',      displayName: 'Dr. Marvin Monroe',  phone: '1144440026', notes: null },
  { username: 'demo_client27',       email: 'client27@demo.test',      displayName: 'Disco Stu',           phone: '1144440027', notes: null },
  { username: 'demo_client28',       email: 'client28@demo.test',      displayName: 'Lionel Hutz',         phone: '1144440028', notes: null },
  { username: 'demo_client29',       email: 'client29@demo.test',      displayName: 'Gil Gunderson',       phone: '1144440029', notes: null },
  { username: 'demo_client30',       email: 'client30@demo.test',      displayName: 'Bleeding Gums Murphy', phone: '1144440030', notes: null },
  // No-relation clients: never assigned an appointment, so they don't show under a professional's
  // "my clients" list until the "include clients with no prior relationship" box is ticked.
  { username: 'demo_client31',       email: 'client31@demo.test',      displayName: 'Ruth Powers',         phone: '1144440031', notes: null },
  { username: 'demo_client32',       email: 'client32@demo.test',      displayName: 'Luann Van Houten',    phone: '1144440032', notes: null },
  { username: 'demo_client33',       email: 'client33@demo.test',      displayName: 'Agnes Skinner',       phone: '1144440033', notes: null },
  { username: 'demo_client34',       email: 'client34@demo.test',      displayName: 'Jimbo Jones',         phone: '1144440034', notes: null },
] as const;

// Clients with NO relationship to demo_pro (Marge): excluded from her rotation so they demonstrate
// the "no prior relationship" filter on her clients tab. They still get appointments with the OTHER
// professionals, so they're real clients with history elsewhere — just not seen by Marge.
const NO_RELATION_TO_MARGE_USERNAMES: readonly string[] = [
  'demo_client31', 'demo_client32', 'demo_client33', 'demo_client34',
];

type PoolLike = Pick<Pool, 'query'>;

async function pickId(pool: PoolLike, sql: string, params: unknown[]): Promise<string | null> {
  const r = await pool.query<{ id: string }>(sql, params);
  return r.rows[0]?.id ?? null;
}

async function upsertBusiness(pool: PoolLike): Promise<string> {
  const existing = await pickId(pool, `SELECT id FROM businesses ORDER BY id LIMIT 1`, []);
  if (existing) return existing;
  return (await pickId(
    pool,
    `INSERT INTO businesses (name, timezone, currency_code) VALUES ($1, $2, 'ARS') RETURNING id`,
    [BUSINESS_NAME, TIMEZONE],
  ))!;
}

async function upsertUser(
  pool: PoolLike,
  businessId: string,
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
  const { passwordHash, passwordSalt } = await hashPassword(DEMO_PASSWORD);
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

async function upsertService(
  pool: PoolLike,
  businessId: string,
  name: string,
  durationMinutes: number,
  priceArs: string,
): Promise<string> {
  const existing = await pickId(pool, `SELECT id FROM services WHERE business_id = $1 AND name = $2`, [businessId, name]);
  if (existing) return existing;
  return (await pickId(
    pool,
    `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [businessId, name, durationMinutes, priceArs],
  ))!;
}

async function upsertResource(
  pool: PoolLike,
  businessId: string,
  name: string,
): Promise<string> {
  const existing = await pickId(pool, `SELECT id FROM resources WHERE business_id = $1 AND name = $2`, [businessId, name]);
  if (existing) return existing;
  return (await pickId(
    pool,
    `INSERT INTO resources (business_id, name) VALUES ($1, $2) RETURNING id`,
    [businessId, name],
  ))!;
}

async function upsertSchedule(
  pool: PoolLike,
  owner: { professionalUserId?: string; resourceId?: string },
  weekly: object,
): Promise<void> {
  const valid = validateWeeklySchedule(weekly);
  if (!valid.ok) throw new Error(`Invalid weekly schedule: ${valid.errors.join(', ')}`);
  const col = owner.professionalUserId ? 'professional_user_id' : 'resource_id';
  const id  = owner.professionalUserId ?? owner.resourceId;
  const existing = await pickId(pool, `SELECT id FROM schedules WHERE ${col} = $1`, [id]);
  if (existing) {
    await pool.query(`UPDATE schedules SET weekly = $1 WHERE ${col} = $2`, [JSON.stringify(weekly), id]);
    return;
  }
  await pool.query(`INSERT INTO schedules (${col}, weekly) VALUES ($1, $2)`, [id, JSON.stringify(weekly)]);
}

async function upsertScheduleException(
  pool: PoolLike,
  owner: { professionalUserId?: string; resourceId?: string },
  date: string,
  opts: { isUnavailable: boolean; reason?: string; startTime?: string; endTime?: string; granularityMinutes?: number },
): Promise<void> {
  const col = owner.professionalUserId ? 'professional_user_id' : 'resource_id';
  const id  = owner.professionalUserId ?? owner.resourceId;
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

async function upsertClientPrice(
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

async function upsertGrant(
  pool: PoolLike,
  professionalUserId: string,
  granteeUserId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO calendar_grants (professional_user_id, grantee_user_id)
     VALUES ($1, $2) ON CONFLICT (professional_user_id, grantee_user_id) DO NOTHING`,
    [professionalUserId, granteeUserId],
  );
}

async function upsertProfessionalService(
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

async function upsertAppointment(
  pool: PoolLike,
  opts: {
    clientUserId: string;
    professionalUserId: string;
    resourceId?: string | null;
    serviceId: string;
    startsAt: string;
    durationMinutes: number;
    state: string;
    price: string;
    name?: string | null;
    description?: string | null;
    staffNote?: string | null;
    overrideConflict?: boolean;
    overrideActorId?: string | null;
  },
): Promise<string> {
  // Natural key: same professional + client + service + start time. Idempotent.
  const existing = await pickId(
    pool,
    `SELECT id FROM appointments
     WHERE professional_user_id = $1 AND client_user_id = $2 AND service_id = $3 AND starts_at = $4`,
    [opts.professionalUserId, opts.clientUserId, opts.serviceId, opts.startsAt],
  );
  if (existing) return existing;
  const r = await pool.query<{ id: string }>(
    `INSERT INTO appointments
       (client_user_id, professional_user_id, resource_id, service_id, starts_at,
        duration_minutes, state, price, name, description, staff_note,
        override_conflict, override_actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      opts.clientUserId, opts.professionalUserId, opts.resourceId ?? null, opts.serviceId, opts.startsAt,
      opts.durationMinutes, opts.state, opts.price, opts.name ?? null,
      opts.description ?? null, opts.staffNote ?? null,
      opts.overrideConflict ?? false, opts.overrideActorId ?? null,
    ],
  );
  return r.rows[0].id;
}

// All appointment start instants (epoch ms) already booked for a professional. Preloaded once per
// professional so the fill can skip taken slots in memory instead of a query per slot.
async function existingStarts(pool: PoolLike, professionalUserId: string): Promise<Set<number>> {
  const r = await pool.query<{ starts_at: string }>(
    `SELECT starts_at FROM appointments WHERE professional_user_id = $1`,
    [professionalUserId],
  );
  return new Set(r.rows.map((x) => new Date(x.starts_at).getTime()));
}

async function unavailableDates(pool: PoolLike, professionalUserId: string): Promise<Set<string>> {
  const r = await pool.query<{ d: string }>(
    `SELECT to_char(exception_date, 'YYYY-MM-DD') d FROM schedule_exceptions
     WHERE professional_user_id = $1 AND is_unavailable = true`,
    [professionalUserId],
  );
  return new Set(r.rows.map((x) => x.d));
}

// Fills ~80% of a professional's slots across the whole seeding window so the demo calendar looks
// busy for the next several weeks. Deterministic (no randomness) → idempotent: slot→client is a pure
// function of position, upsertAppointment dedups by (professional, client, service, start), and the
// preloaded start set skips anything already booked (curated appointments, requests, prior runs).
// Skips any day the professional is unavailable. Duration = the slot granularity so appointments
// tile the grid without overlapping. Some professionals get a resource, some don't (a null resource
// is a valid appointment).
async function fillProfessionalDays(
  pool: PoolLike,
  opts: {
    professionalUserId: string;
    serviceId: string;
    weekly: Record<string, WeeklyBlock[]>;
    price: string;
    resourceId?: string | null;
    clientUserIds: string[];
    clientOffset: number;
    nowMs: number;
  },
): Promise<number> {
  const unavailable = await unavailableDates(pool, opts.professionalUserId);
  const taken = await existingStarts(pool, opts.professionalUserId);
  let slotIndex = 0;
  let filled = 0;
  for (const day of seedDays()) {
    for (const block of opts.weekly[day.key] ?? []) {
      for (const hm of slotStartTimes(block)) {
        const idx = slotIndex++;
        if (idx % 5 === 4) continue; // leave one slot in five open → ~80% density
        if (unavailable.has(day.date)) continue;
        const startsAt = `${day.date}T${hm}:00-03:00`;
        const ms = new Date(startsAt).getTime();
        if (taken.has(ms)) continue;
        // Index the client by placements made, NOT the raw slot index: the density skip drops every
        // 5th slot, and a pool size that shares a factor with 5 would otherwise starve whole client
        // residues. Round-robin over actual placements keeps coverage uniform for any pool size.
        const clientUserId = opts.clientUserIds[(filled + opts.clientOffset) % opts.clientUserIds.length];
        await upsertAppointment(pool, {
          clientUserId,
          professionalUserId: opts.professionalUserId,
          resourceId: opts.resourceId ?? null,
          serviceId: opts.serviceId,
          startsAt,
          durationMinutes: block.granularity_minutes,
          state: ms < opts.nowMs ? 'completed' : 'scheduled',
          price: opts.price,
        });
        taken.add(ms);
        filled++;
      }
    }
  }
  return filled;
}

// Append-only guard: insert only if no row with the same deterministic natural key exists.
// Uses a CTE with explicit casts to avoid "inconsistent types" for parameters reused across
// INSERT + WHERE NOT EXISTS in a single statement.
async function guardedLedgerInsert(
  pool: PoolLike,
  opts: {
    clientUserId: string;
    appointmentId?: string | null;
    entryType: string;
    amountArs: string;
    description: string;    // stable demo tag — serves as natural key along with client+type+amount
    actorUserId?: string | null;
  },
): Promise<void> {
  // Duplicating scalar params avoids Postgres type-inference conflicts when the same
  // positional parameter appears in both the SELECT list and a WHERE predicate with
  // different expected types (text vs. varchar CHECK constraint, etc.).
  await pool.query(
    `INSERT INTO ledger_entries (client_user_id, appointment_id, entry_type, amount_ars, description, actor_user_id)
     SELECT $1::bigint, $2::bigint, $3::text, $4::numeric, $5::text, $6::bigint
     WHERE NOT EXISTS (
       SELECT 1 FROM ledger_entries
       WHERE client_user_id = $7::bigint
         AND entry_type     = $8::text
         AND amount_ars     = $9::numeric
         AND description    = $10::text
     )`,
    [
      opts.clientUserId, opts.appointmentId ?? null, opts.entryType, opts.amountArs, opts.description, opts.actorUserId ?? null,
      opts.clientUserId, opts.entryType, opts.amountArs, opts.description,
    ],
  );
}

// Append-only guard: insert only if no row with the same (entity_type, entity_id, event_type, outcome) exists.
// Duplicating scalar params avoids Postgres type-inference conflicts (same param in SELECT + WHERE).
async function guardedAuditInsert(
  pool: PoolLike,
  opts: {
    businessId: string;
    actorUserId?: string | null;
    eventType: string;
    entityType: string;
    entityId: string;
    outcome: string;
    ip?: string | null;
    details?: object | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO audit_events (business_id, actor_user_id, event_type, entity_type, entity_id, outcome, ip, details)
     SELECT $1::bigint, $2::bigint, $3::text, $4::text, $5::bigint, $6::text, $7::text, $8::jsonb
     WHERE NOT EXISTS (
       SELECT 1 FROM audit_events
       WHERE entity_type = $9::text
         AND entity_id   = $10::bigint
         AND event_type  = $11::text
         AND outcome     = $12::text
     )`,
    [
      opts.businessId, opts.actorUserId ?? null, opts.eventType,
      opts.entityType, opts.entityId, opts.outcome,
      opts.ip ?? null, JSON.stringify(opts.details ?? {}),
      opts.entityType, opts.entityId, opts.eventType, opts.outcome,
    ],
  );
}

export async function seedDemo(pool: PoolLike): Promise<void> {
  const businessId = await upsertBusiness(pool);

  const uids: Record<string, string> = {};
  for (const u of STAFF_USERS) {
    uids[u.username] = await upsertUser(pool, businessId, {
      ...u,
      mustChangePassword: u.username === 'demo_reset',
    });
  }

  for (const c of CLIENT_USERS) {
    uids[c.username] = await upsertUser(pool, businessId, {
      ...c,
      role: 'Client',
      // Distinct 8-digit demo DNIs derived from the phone tail, so client search by DNI is testable.
      dni: `30${c.phone.slice(-6)}`,
    });
  }

  const svcSesion    = await upsertService(pool, businessId, 'Sesión individual',     50, '8000.00');
  const svcNutricion = await upsertService(pool, businessId, 'Consulta nutricional',  40, '7000.00');
  const svcKineso    = await upsertService(pool, businessId, 'Sesión de kinesiología', 60, '9000.00');
  const svcMedico    = await upsertService(pool, businessId, 'Consulta médica',        30, '5000.00');

  const room1 = await upsertResource(pool, businessId, 'Consultorio 1');
  const room2 = await upsertResource(pool, businessId, 'Consultorio 2');
  const room3 = await upsertResource(pool, businessId, 'Consultorio 3');
  const room4 = await upsertResource(pool, businessId, 'Consultorio 4');
  const room5 = await upsertResource(pool, businessId, 'Consultorio 5');

  await upsertSchedule(pool, { professionalUserId: uids['demo_pro'] },   weeklyFullTime50());
  await upsertSchedule(pool, { professionalUserId: uids['demo_pro2'] },  weeklyFullTime50());
  await upsertSchedule(pool, { professionalUserId: uids['demo_pro3'] },  weeklyMorning40());
  await upsertSchedule(pool, { professionalUserId: uids['demo_pro4'] },  weeklyAfternoon60());
  await upsertSchedule(pool, { professionalUserId: uids['demo_pro5'] },  weeklyFullTime50());
  await upsertSchedule(pool, { professionalUserId: uids['demo_pro6'] },  weeklyMorning30());
  await upsertSchedule(pool, { professionalUserId: uids['demo_reset'] }, weeklyFullTime50());
  await upsertSchedule(pool, { resourceId: room1 }, weeklyRoom());
  await upsertSchedule(pool, { resourceId: room2 }, weeklyRoom());
  await upsertSchedule(pool, { resourceId: room3 }, weeklyRoom());
  await upsertSchedule(pool, { resourceId: room4 }, weeklyRoom());
  await upsertSchedule(pool, { resourceId: room5 }, weeklyRoom());

  await upsertScheduleException(pool, { professionalUserId: uids['demo_pro'] },  '2026-07-09', { isUnavailable: true, reason: '9 de julio — feriado nacional' });
  await upsertScheduleException(pool, { professionalUserId: uids['demo_pro2'] }, '2026-07-15', { isUnavailable: false, startTime: '14:00', endTime: '18:00', granularityMinutes: 30, reason: 'Turno modificado — tarde especial' });
  await upsertScheduleException(pool, { professionalUserId: uids['demo_pro3'] }, '2026-07-09', { isUnavailable: true, reason: 'Capacitación' });
  // Two-day maintenance closure on Consultorio 3, on normally-open weekdays flanked by open days —
  // demonstrates the resource-availability overlay (grey-blocked island against green availability).
  await upsertScheduleException(pool, { resourceId: room3 }, '2026-07-08', { isUnavailable: true, reason: 'Mantenimiento de consultorio' });
  await upsertScheduleException(pool, { resourceId: room3 }, '2026-07-09', { isUnavailable: true, reason: 'Mantenimiento de consultorio' });

  await upsertClientPrice(pool, uids['demo_client'],         uids['demo_pro'],  svcSesion, '6500.00');
  await upsertClientPrice(pool, uids['demo_client_overdue'], uids['demo_pro'],  svcSesion, '8000.00');
  await upsertClientPrice(pool, uids['demo_client2'],        uids['demo_pro3'], svcNutricion, '5500.00');
  await upsertClientPrice(pool, uids['demo_client3'],        uids['demo_pro4'], svcKineso, '10000.00');

  await upsertGrant(pool, uids['demo_pro'],  uids['demo_recep']);
  await upsertGrant(pool, uids['demo_pro2'], uids['demo_recep']);

  // Each professional offers only the service that matches their specialty (drives the booking
  // form's service list). Covers every (professional, service) pair used by the seeded appointments.
  await upsertProfessionalService(pool, uids['demo_pro'],   svcSesion);
  await upsertProfessionalService(pool, uids['demo_pro2'],  svcSesion);
  await upsertProfessionalService(pool, uids['demo_pro3'],  svcNutricion);
  await upsertProfessionalService(pool, uids['demo_pro4'],  svcKineso);
  await upsertProfessionalService(pool, uids['demo_pro5'],  svcSesion);
  await upsertProfessionalService(pool, uids['demo_pro6'],  svcMedico);
  await upsertProfessionalService(pool, uids['demo_reset'], svcSesion);

  const appt1 = await upsertAppointment(pool, {
    clientUserId: uids['demo_client'], professionalUserId: uids['demo_pro'],
    resourceId: room1, serviceId: svcSesion,
    startsAt: '2026-06-02T10:00:00-03:00', durationMinutes: 50,
    state: 'completed', price: '6500.00', name: 'Sesión 1 - Homero',
  });
  const appt2 = await upsertAppointment(pool, {
    clientUserId: uids['demo_client_overdue'], professionalUserId: uids['demo_pro'],
    resourceId: room1, serviceId: svcSesion,
    startsAt: '2026-06-02T11:00:00-03:00', durationMinutes: 50,
    state: 'completed', price: '8000.00', name: 'Sesión 1 - Bart',
  });
  const appt3 = await upsertAppointment(pool, {
    clientUserId: uids['demo_client2'], professionalUserId: uids['demo_pro3'],
    resourceId: room2, serviceId: svcNutricion,
    startsAt: '2026-06-03T09:00:00-03:00', durationMinutes: 40,
    state: 'completed', price: '5500.00', name: 'Consulta nutricional - Marge',
  });
  await upsertAppointment(pool, {
    clientUserId: uids['demo_client3'], professionalUserId: uids['demo_pro4'],
    resourceId: room3, serviceId: svcKineso,
    startsAt: '2026-06-04T14:00:00-03:00', durationMinutes: 60,
    state: 'completed', price: '10000.00', name: 'Kinesiología - Apu',
  });
  await upsertAppointment(pool, {
    clientUserId: uids['demo_client4'], professionalUserId: uids['demo_pro2'],
    serviceId: svcSesion,
    startsAt: '2026-06-09T10:00:00-03:00', durationMinutes: 50,
    state: 'completed', price: '8000.00', name: 'Sesión - Lenny',
  });
  await upsertAppointment(pool, {
    clientUserId: uids['demo_client5'], professionalUserId: uids['demo_pro5'],
    serviceId: svcSesion,
    startsAt: '2026-06-10T14:00:00-03:00', durationMinutes: 50,
    state: 'completed', price: '8000.00', name: 'Sesión cognitiva - Carl',
  });
  await upsertAppointment(pool, {
    clientUserId: uids['demo_client6'], professionalUserId: uids['demo_pro6'],
    serviceId: svcMedico,
    startsAt: '2026-06-11T09:00:00-03:00', durationMinutes: 30,
    state: 'completed', price: '5000.00', name: 'Consulta médica - Selma',
  });
  await upsertAppointment(pool, {
    clientUserId: uids['demo_client7'], professionalUserId: uids['demo_pro'],
    serviceId: svcSesion,
    startsAt: '2026-06-16T10:00:00-03:00', durationMinutes: 50,
    state: 'no_show', price: '8000.00', name: 'Sesión - Patty (no asistió)',
    staffNote: 'Paciente no se presentó sin aviso',
  });
  await upsertAppointment(pool, {
    clientUserId: uids['demo_client8'], professionalUserId: uids['demo_pro2'],
    serviceId: svcSesion,
    startsAt: '2026-06-17T11:00:00-03:00', durationMinutes: 50,
    state: 'no_show', price: '8000.00', name: 'Sesión - Skinner (no asistió)',
  });
  const apptRejected = await upsertAppointment(pool, {
    clientUserId: uids['demo_client9'], professionalUserId: uids['demo_pro3'],
    serviceId: svcNutricion,
    startsAt: '2026-06-24T09:00:00-03:00', durationMinutes: 40,
    state: 'rejected', price: '7000.00', name: 'Consulta rechazada - Nelson',
  });
  await upsertAppointment(pool, {
    clientUserId: uids['demo_client'], professionalUserId: uids['demo_pro'],
    resourceId: room1, serviceId: svcSesion,
    startsAt: '2026-07-07T10:00:00-03:00', durationMinutes: 50,
    state: 'scheduled', price: '6500.00', name: 'Sesión - Homero',
  });
  await upsertAppointment(pool, {
    clientUserId: uids['demo_client_overdue'], professionalUserId: uids['demo_pro'],
    resourceId: room1, serviceId: svcSesion,
    startsAt: '2026-07-07T11:00:00-03:00', durationMinutes: 50,
    state: 'scheduled', price: '8000.00', name: 'Sesión - Bart',
  });
  await upsertAppointment(pool, {
    clientUserId: uids['demo_client2'], professionalUserId: uids['demo_pro3'],
    resourceId: room2, serviceId: svcNutricion,
    startsAt: '2026-07-07T09:00:00-03:00', durationMinutes: 40,
    state: 'scheduled', price: '5500.00', name: 'Nutrición - Marge',
  });
  await upsertAppointment(pool, {
    clientUserId: uids['demo_client10'], professionalUserId: uids['demo_pro4'],
    resourceId: room3, serviceId: svcKineso,
    startsAt: '2026-07-07T14:00:00-03:00', durationMinutes: 60,
    state: 'scheduled', price: '9000.00', name: 'Kinesiología - Milhouse',
  });
  // Sobreturno: intentionally overlaps an existing slot; requires admin conflict override.
  const apptSobreturno = await upsertAppointment(pool, {
    clientUserId: uids['demo_client3'], professionalUserId: uids['demo_pro'],
    resourceId: room1, serviceId: svcSesion,
    startsAt: '2026-07-07T10:00:00-03:00', durationMinutes: 50,
    state: 'scheduled', price: '6500.00', name: 'Sesión sobreturno - Apu',
    overrideConflict: true, overrideActorId: uids['demo_admin'],
    description: 'Turno extra autorizado por admin; se superpone intencionalmente',
  });
  await upsertAppointment(pool, {
    clientUserId: uids['demo_client4'], professionalUserId: uids['demo_pro2'],
    serviceId: svcSesion,
    startsAt: '2026-07-13T10:00:00-03:00', durationMinutes: 50,
    state: 'scheduled', price: '8000.00', name: 'Sesión - Lenny (semana próxima)',
  });
  await upsertAppointment(pool, {
    clientUserId: uids['demo_client5'], professionalUserId: uids['demo_pro5'],
    serviceId: svcSesion,
    startsAt: '2026-07-14T14:00:00-03:00', durationMinutes: 50,
    state: 'scheduled', price: '8000.00', name: 'Sesión cognitiva - Carl (semana próxima)',
  });
  await upsertAppointment(pool, {
    clientUserId: uids['demo_client11'], professionalUserId: uids['demo_pro'],
    serviceId: svcSesion,
    startsAt: '2026-07-21T10:00:00-03:00', durationMinutes: 50,
    state: 'requested', price: '8000.00', name: 'Solicitud - Ralph',
  });
  await upsertAppointment(pool, {
    clientUserId: uids['demo_client12'], professionalUserId: uids['demo_pro3'],
    serviceId: svcNutricion,
    startsAt: '2026-07-22T09:00:00-03:00', durationMinutes: 40,
    state: 'requested', price: '7000.00', name: 'Solicitud nutricional - Wiggum',
  });
  await upsertAppointment(pool, {
    clientUserId: uids['demo_client13'], professionalUserId: uids['demo_pro2'],
    serviceId: svcSesion,
    startsAt: '2026-07-23T11:00:00-03:00', durationMinutes: 50,
    state: 'requested', price: '8000.00', name: 'Solicitud - Bob',
  });

  const nowMs = Date.now();
  // The portal login client (Homero) is kept OUT of the auto-rotation so his "Mis turnos" stays a
  // realistic handful (seeded explicitly below) instead of an appointment with every professional.
  const ROTATION_EXCLUDED = new Set<string>(['demo_client']);
  const clientIds = CLIENT_USERS
    .filter((c) => !ROTATION_EXCLUDED.has(c.username))
    .map((c) => uids[c.username]);
  // Marge's rotation also drops the no-relation clients so they never appear on her calendar; every
  // other professional uses the full pool, so those clients still build history elsewhere.
  const margeClientIds = CLIENT_USERS
    .filter((c) => !ROTATION_EXCLUDED.has(c.username) && !NO_RELATION_TO_MARGE_USERNAMES.includes(c.username))
    .map((c) => uids[c.username]);

  // Homero (portal demo login): a small, realistic agenda — a couple upcoming plus the curated
  // history already seeded above. Dates are relative to the demo "current" week (2026-07-08).
  const homeroUpcoming = [
    { pro: 'demo_pro',  service: svcSesion, price: '6500.00', date: '2026-07-13', start: '14:00', state: 'scheduled' },
    { pro: 'demo_pro3', service: svcNutricion, price: '7000.00', date: '2026-07-16', start: '09:00', state: 'scheduled' },
    { pro: 'demo_pro',  service: svcSesion, price: '6500.00', date: '2026-07-20', start: '11:30', state: 'requested' },
  ];
  for (const h of homeroUpcoming) {
    await upsertAppointment(pool, {
      clientUserId: uids['demo_client'], professionalUserId: uids[h.pro],
      resourceId: null, serviceId: h.service,
      startsAt: `${h.date}T${h.start}:00-03:00`, durationMinutes: h.service === svcNutricion ? 40 : 50,
      state: h.state, price: h.price,
    });
  }

  // Pending client requests on Marge's future agenda (state 'requested' → awaiting staff approval).
  // Seeded BEFORE the dense fill so those slots are reserved and the fill routes around them.
  const margeRequests = [
    { client: 'demo_client11', date: '2026-07-13', start: '09:00' },
    { client: 'demo_client16', date: '2026-07-15', start: '10:40' },
    { client: 'demo_client19', date: '2026-07-20', start: '13:10' },
    { client: 'demo_client24', date: '2026-07-28', start: '09:50' },
    { client: 'demo_client27', date: '2026-08-04', start: '11:30' },
  ];
  for (const req of margeRequests) {
    await upsertAppointment(pool, {
      clientUserId: uids[req.client], professionalUserId: uids['demo_pro'],
      resourceId: null, serviceId: svcSesion,
      startsAt: `${req.date}T${req.start}:00-03:00`, durationMinutes: 50,
      state: 'requested', price: '8000.00', name: 'Solicitud de turno',
    });
  }

  // Dense fill: ~80% of each professional's slots across the seeding window, so the calendar looks
  // realistic. Runs AFTER the curated appointments and requests above so it skips their slots.
  const denseConfig: {
    pro: string; service: string; price: string; resource: string | null;
    weekly: Record<string, WeeklyBlock[]>; offset: number;
  }[] = [
    { pro: 'demo_pro',  service: svcSesion,    price: '8000.00',  resource: room1, weekly: weeklyFullTime50(),  offset: 0 },
    { pro: 'demo_pro2', service: svcSesion,    price: '8000.00',  resource: room2, weekly: weeklyFullTime50(),  offset: 5 },
    { pro: 'demo_pro3', service: svcNutricion, price: '7000.00',  resource: null,  weekly: weeklyMorning40(),   offset: 10 },
    { pro: 'demo_pro4', service: svcKineso,    price: '9000.00',  resource: room4, weekly: weeklyAfternoon60(),  offset: 15 },
    { pro: 'demo_pro5', service: svcSesion,    price: '8000.00',  resource: room5, weekly: weeklyFullTime50(),  offset: 20 },
    { pro: 'demo_pro6', service: svcMedico,    price: '5000.00',  resource: null,  weekly: weeklyMorning30(),   offset: 25 },
  ];

  // Marge (demo_pro) skips the no-relation clients; every other professional draws from the full pool.
  const clientsFor = (pro: string) => (pro === 'demo_pro' ? margeClientIds : clientIds);

  for (const cfg of denseConfig) {
    await fillProfessionalDays(pool, {
      professionalUserId: uids[cfg.pro], serviceId: cfg.service, weekly: cfg.weekly,
      price: cfg.price, resourceId: cfg.resource, clientUserIds: clientsFor(cfg.pro),
      clientOffset: cfg.offset, nowMs,
    });
  }

  // One sobreturno per professional: an extra appointment overlapping their first Monday slot,
  // authorized by admin (override_conflict). Resource-less so it never collides on a room.
  for (const cfg of denseConfig) {
    const monBlock = cfg.weekly.mon?.[0];
    if (!monBlock) continue;
    const startsAt = `2026-07-06T${slotStartTimes(monBlock)[0]}:00-03:00`;
    const clients = clientsFor(cfg.pro);
    await upsertAppointment(pool, {
      clientUserId: clients[(cfg.offset + 3) % clients.length],
      professionalUserId: uids[cfg.pro], resourceId: null, serviceId: cfg.service,
      startsAt, durationMinutes: monBlock.granularity_minutes,
      state: 'scheduled', price: cfg.price, name: 'Sobreturno',
      overrideConflict: true, overrideActorId: uids['demo_admin'],
      description: 'Sobreturno autorizado por admin (se superpone con el turno regular)',
    });
  }

  // Homero: charged + paid in full → zero balance
  await guardedLedgerInsert(pool, {
    clientUserId: uids['demo_client'], appointmentId: appt1,
    entryType: 'charge', amountArs: '6500.00',
    description: 'demo:cargo-sesion-homero-20260602', actorUserId: uids['demo_recep'],
  });
  await guardedLedgerInsert(pool, {
    clientUserId: uids['demo_client'],
    entryType: 'payment', amountArs: '6500.00',
    description: 'demo:pago-homero-20260602', actorUserId: uids['demo_recep'],
  });

  // Bart: two charges, one partial payment, a late fee → positive (overdue) balance
  await guardedLedgerInsert(pool, {
    clientUserId: uids['demo_client_overdue'], appointmentId: appt2,
    entryType: 'charge', amountArs: '8000.00',
    description: 'demo:cargo-sesion-bart-20260602', actorUserId: uids['demo_recep'],
  });
  await guardedLedgerInsert(pool, {
    clientUserId: uids['demo_client_overdue'],
    entryType: 'charge', amountArs: '8000.00',
    description: 'demo:cargo-sesion-bart-20260707', actorUserId: uids['demo_recep'],
  });
  await guardedLedgerInsert(pool, {
    clientUserId: uids['demo_client_overdue'],
    entryType: 'payment', amountArs: '5000.00',
    description: 'demo:pago-parcial-bart', actorUserId: uids['demo_recep'],
  });
  await guardedLedgerInsert(pool, {
    clientUserId: uids['demo_client_overdue'],
    entryType: 'adjustment_debit', amountArs: '500.00',
    description: 'demo:ajuste-mora-bart', actorUserId: uids['demo_admin'],
  });

  // Marge: nutrition charge + payment + a credit correction → zero balance
  await guardedLedgerInsert(pool, {
    clientUserId: uids['demo_client2'], appointmentId: appt3,
    entryType: 'charge', amountArs: '5500.00',
    description: 'demo:cargo-nutricion-marge-20260603', actorUserId: uids['demo_recep'],
  });
  await guardedLedgerInsert(pool, {
    clientUserId: uids['demo_client2'],
    entryType: 'payment', amountArs: '5500.00',
    description: 'demo:pago-marge-20260603', actorUserId: uids['demo_recep'],
  });
  await guardedLedgerInsert(pool, {
    clientUserId: uids['demo_client2'],
    entryType: 'adjustment_credit', amountArs: '200.00',
    description: 'demo:ajuste-credito-marge', actorUserId: uids['demo_admin'],
  });

  // Apu: charged + paid in full
  await guardedLedgerInsert(pool, {
    clientUserId: uids['demo_client3'],
    entryType: 'charge', amountArs: '10000.00',
    description: 'demo:cargo-kineso-apu-20260604', actorUserId: uids['demo_recep'],
  });
  await guardedLedgerInsert(pool, {
    clientUserId: uids['demo_client3'],
    entryType: 'payment', amountArs: '10000.00',
    description: 'demo:pago-apu-20260604', actorUserId: uids['demo_recep'],
  });

  await guardedAuditInsert(pool, {
    businessId, actorUserId: uids['demo_admin'],
    eventType: 'login', entityType: 'auth.users',
    entityId: uids['demo_admin'], outcome: 'success', ip: '192.168.1.10',
  });
  await guardedAuditInsert(pool, {
    businessId, actorUserId: uids['demo_recep'],
    eventType: 'login', entityType: 'auth.users',
    entityId: uids['demo_recep'], outcome: 'success', ip: '192.168.1.11',
  });
  await guardedAuditInsert(pool, {
    businessId, actorUserId: uids['demo_recep'],
    eventType: 'appointment_created', entityType: 'appointments',
    entityId: appt1, outcome: 'success',
  });
  await guardedAuditInsert(pool, {
    businessId, actorUserId: uids['demo_admin'],
    eventType: 'conflict_override', entityType: 'appointments',
    entityId: apptSobreturno, outcome: 'success',
    details: { reason: 'Urgencia del paciente; autorizó admin' },
  });
  await guardedAuditInsert(pool, {
    businessId, actorUserId: uids['demo_pro'],
    eventType: 'appointment_completed', entityType: 'appointments',
    entityId: appt1, outcome: 'success',
  });
  await guardedAuditInsert(pool, {
    businessId, actorUserId: uids['demo_pro3'],
    eventType: 'appointment_rejected', entityType: 'appointments',
    entityId: apptRejected, outcome: 'success',
  });
  await guardedAuditInsert(pool, {
    businessId, actorUserId: uids['demo_recep'],
    eventType: 'ledger_entry_created', entityType: 'ledger_entries',
    entityId: uids['demo_client'], outcome: 'success',
  });
  await guardedAuditInsert(pool, {
    businessId, actorUserId: uids['demo_admin'],
    eventType: 'grant_created', entityType: 'calendar_grants',
    entityId: uids['demo_pro'], outcome: 'success',
  });
  // Denied action proves the audit trail records refused authorization attempts.
  await guardedAuditInsert(pool, {
    businessId, actorUserId: uids['demo_client'],
    eventType: 'appointment_update', entityType: 'appointments',
    entityId: appt2, outcome: 'denied', ip: '10.0.0.5',
    details: { reason: 'Client attempted state change not permitted' },
  });
}

async function main() {
  const pool = createOwnerPool();
  try {
    await seedDemo(pool);
    console.log('Demo seed complete.');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
