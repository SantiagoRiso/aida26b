import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { mountGenericRoutes } from '../src/app';
import type { AuthUser } from '../src/auth';

// grantScope reads on surrogate-pk owner tables (schedule_blocks): a Receptionist sees only the
// blocks of professionals they hold a calendar grant on. Regression guard for the pk-vs-owner
// bug — grant scoping must match the OWNER column (professional_user_id), never the row id, or a
// granted Receptionist sees no rows at all.
let pool: Pool;
let server: http.Server;
let baseUrl: string;
let currentUser: AuthUser;

const injectUser: express.RequestHandler = (req, _res, next) => {
  (req as express.Request & { user?: AuthUser }).user = currentUser;
  next();
};

let bizId: string;
let pro1: number;
let pro2: number;
let recepNoGrant: number;
let recepWithGrant: number;
let block1Id: string; // pro1's block
let block2Id: string; // pro2's block

async function seedUser(username: string, role: string): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ($1, $2, $3, 'h', 's', $4, $5, false) RETURNING id`,
    [username, `${username}@test.local`, username, role, bizId]
  );
  return Number(r.rows[0].id);
}

async function seedBlock(professionalUserId: number, weekday: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO schedule_blocks (professional_user_id, resource_id, weekday, start_time, end_time)
     VALUES ($1, NULL, $2, '09:00', '17:00') RETURNING id`,
    [professionalUserId, weekday]
  );
  return r.rows[0].id;
}

const asUser = (id: number, role: AuthUser['role']): AuthUser => ({
  id,
  username: `u${id}`,
  email: null,
  role,
  business_id: Number(bizId),
  is_active: true,
  must_change_password: false,
});

async function listBlocks(): Promise<Array<{ id: string; professional_user_id: string | null }>> {
  const res = await fetch(`${baseUrl}/api/schedule_blocks`);
  const body = (await res.json()) as { data: Array<{ id: string; professional_user_id: string | null }> };
  return body.data;
}

async function getBlock(id: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/schedule_blocks?id=${id}`);
  return res.status;
}

// A real editor PUT keeps the block's owner and moves its window — full-object, so the (unchanged)
// owner is sent verbatim. Passing the true owner also lets the own-schedule guard, not the
// owner-immutability check, decide authz on an ungranted block.
async function putBlockWeekday(id: string, ownerUserId: number, weekday: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/schedule_blocks/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      professional_user_id: String(ownerUserId),
      resource_id: null,
      weekday,
      start_time: '09:00',
      end_time: '17:00',
    }),
  });
  return res.status;
}

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const biz = await pool.query<{ id: string }>(`INSERT INTO businesses (name) VALUES ('Grant Read Biz') RETURNING id`);
  bizId = biz.rows[0].id;

  pro1 = await seedUser('gsr_pro1', 'Professional');
  pro2 = await seedUser('gsr_pro2', 'Professional');
  recepNoGrant = await seedUser('gsr_recep_no', 'Receptionist');
  recepWithGrant = await seedUser('gsr_recep_yes', 'Receptionist');

  await pool.query(`INSERT INTO calendar_grants (professional_user_id, grantee_user_id) VALUES ($1, $2)`, [
    pro1,
    recepWithGrant,
  ]);

  block1Id = await seedBlock(pro1, 'mon');
  block2Id = await seedBlock(pro2, 'tue');

  const app = express();
  app.use(express.json());
  app.use(injectUser);
  mountGenericRoutes(app, pool);

  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('grantScope reads on schedule_blocks (owner-column, not pk)', () => {
  test('a Receptionist WITH a grant sees only the granted professional\'s blocks', async () => {
    currentUser = asUser(recepWithGrant, 'Receptionist');
    const rows = await listBlocks();
    expect(rows.map((r) => r.id)).toEqual([block1Id]);
    expect(rows.map((r) => r.professional_user_id)).toEqual([String(pro1)]);
  });

  test('a Receptionist WITHOUT a grant sees no blocks', async () => {
    currentUser = asUser(recepNoGrant, 'Receptionist');
    expect(await listBlocks()).toEqual([]);
  });

  test('an Admin sees every block in the business', async () => {
    currentUser = asUser(900001, 'Admin');
    const ids = (await listBlocks()).map((r) => r.id).sort();
    expect(ids).toEqual([block1Id, block2Id].sort());
  });

  test('a granted Receptionist may GET the granted block by id, but not an ungranted one', async () => {
    currentUser = asUser(recepWithGrant, 'Receptionist');
    expect(await getBlock(block1Id)).toBe(200);
    expect(await getBlock(block2Id)).toBe(404); // ungranted → hidden, not leaked
  });

  test('a granted Receptionist may PUT the granted block (write path is scoped the same way)', async () => {
    currentUser = asUser(recepWithGrant, 'Receptionist');
    expect(await putBlockWeekday(block1Id, pro1, 'wed')).toBe(202);
  });

  test('a granted Receptionist may NOT PUT an ungranted block', async () => {
    currentUser = asUser(recepWithGrant, 'Receptionist');
    // The own-schedule guard rejects the ungranted owner before the scoped UPDATE runs.
    expect(await putBlockWeekday(block2Id, pro2, 'wed')).toBe(403);
  });
});
