import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { mountGenericRoutes } from '../src/app';
import type { AuthUser } from '../src/auth';

// The weekly-JSONB set-schedule endpoint was replaced by generic CRUD on schedule_blocks. This
// exercises the ownership/grant scoping that CRUD gives the new table: a Professional manages only
// their own blocks; a Receptionist needs a calendar grant; an Admin manages all in the business.
let pool: Pool;
let server: http.Server;
let baseUrl: string;
let currentUser: AuthUser;

let bizId: number;
let pro1: number;
let pro2: number;
let recepGranted: number;
let recepUngranted: number;
let pro1Block: number;

const injectUser: express.RequestHandler = (req, _res, next) => {
  (req as express.Request & { user?: AuthUser }).user = currentUser;
  next();
};

type Envelope = {
  success?: boolean;
  data?: Record<string, string | number | boolean | null> | Record<string, string | number | boolean | null>[];
  meta?: { page: number; limit: number; total: number };
  error?: { code: string; message: string; fields?: Record<string, string> };
};

async function api(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Envelope) : null };
}

const asUser = (id: number, role: AuthUser['role']): AuthUser => ({
  id,
  username: `u${id}`,
  email: null,
  role,
  business_id: bizId,
  is_active: true,
  must_change_password: false,
});

async function seedUser(username: string, role: AuthUser['role']): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ($1, $2, $3, 'h', 's', $4, $5, false) RETURNING id`,
    [username, `${username}@test.local`, username, role, bizId],
  );
  return Number(r.rows[0].id);
}

async function seedBlock(professionalUserId: number): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO schedule_blocks (professional_user_id, weekday, start_time, end_time)
     VALUES ($1, 'mon', '09:00', '12:00') RETURNING id`,
    [professionalUserId],
  );
  return Number(r.rows[0].id);
}

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const biz = await pool.query<{ id: string }>(`INSERT INTO businesses (name) VALUES ('Blocks Biz') RETURNING id`);
  bizId = Number(biz.rows[0].id);

  pro1 = await seedUser('block_pro1', 'Professional');
  pro2 = await seedUser('block_pro2', 'Professional');
  recepGranted = await seedUser('block_recep_yes', 'Receptionist');
  recepUngranted = await seedUser('block_recep_no', 'Receptionist');

  await pool.query(
    `INSERT INTO calendar_grants (professional_user_id, grantee_user_id) VALUES ($1, $2)`,
    [pro1, recepGranted],
  );

  pro1Block = await seedBlock(pro1);
  await seedBlock(pro2);

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

describe('schedule_blocks generic CRUD scoping', () => {
  test('an Admin sees every block in the business', async () => {
    currentUser = { ...asUser(0, 'Admin'), business_id: bizId };
    const res = await api('/api/schedule_blocks');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  test('a Professional sees only their own block', async () => {
    currentUser = asUser(pro1, 'Professional');
    const res = await api('/api/schedule_blocks');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(String(res.body.data[0].professional_user_id)).toBe(String(pro1));
  });

  test('a granted Receptionist sees the granted professional\'s block', async () => {
    currentUser = asUser(recepGranted, 'Receptionist');
    const res = await api('/api/schedule_blocks');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(String(res.body.data[0].professional_user_id)).toBe(String(pro1));
  });

  test('an ungranted Receptionist sees no blocks', async () => {
    currentUser = asUser(recepUngranted, 'Receptionist');
    const res = await api('/api/schedule_blocks');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  test('a Professional can create their own block', async () => {
    currentUser = asUser(pro1, 'Professional');
    const res = await api('/api/schedule_blocks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        professional_user_id: String(pro1),
        resource_id: null,
        weekday: 'tue',
        start_time: '14:00',
        end_time: '17:00',
      }),
    });
    expect(res.status).toBe(201);
    expect(String(res.body.data.professional_user_id)).toBe(String(pro1));
  });

  test('a Professional cannot update a peer\'s block (own-only, 403)', async () => {
    currentUser = asUser(pro2, 'Professional');
    const res = await api(`/api/schedule_blocks/${pro1Block}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        professional_user_id: String(pro1),
        resource_id: null,
        weekday: 'mon',
        start_time: '08:00',
        end_time: '12:00',
      }),
    });
    expect(res.status).toBe(403);
  });

  test('a Professional cannot delete a peer\'s block (own-only, 403)', async () => {
    currentUser = asUser(pro2, 'Professional');
    const res = await api(`/api/schedule_blocks/${pro1Block}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });
});
