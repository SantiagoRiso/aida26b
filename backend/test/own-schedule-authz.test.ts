import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { mountGenericRoutes } from '../src/app';
import type { AuthUser } from '../src/auth';

// Exercises the D-16 own-schedule guard through the GENERIC write path (post.ts) — a
// schedule_exceptions create targeting a professional — across every role/grant combination.
let pool: Pool;
let server: http.Server;
let baseUrl: string;
let currentUser: AuthUser;

const injectUser: express.RequestHandler = (req, _res, next) => {
  (req as express.Request & { user?: AuthUser }).user = currentUser;
  next();
};

async function createException(professionalUserId: number, exceptionDate: string) {
  const response = await fetch(`${baseUrl}/api/schedule_exceptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Generic writes are full-object: every editable column must be present (nullable ones as null).
    // FK ids are declared type 'string' in the SSOT.
    body: JSON.stringify({
      professional_user_id: String(professionalUserId),
      resource_id: null,
      exception_date: exceptionDate,
      is_unavailable: true,
      start_time: null,
      end_time: null,
      granularity_minutes: null,
      reason: null,
    }),
  });
  return response.status;
}

let bizId: string;
let pro1: number;
let pro2: number;
let recepNoGrant: number;
let recepWithGrant: number;
let clientId: number;

async function seedUser(username: string, role: string): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ($1, $2, $3, 'h', 's', $4, $5, false) RETURNING id`,
    [username, `${username}@test.local`, username, role, bizId]
  );
  return Number(r.rows[0].id);
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

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const biz = await pool.query<{ id: string }>(`INSERT INTO businesses (name) VALUES ('Authz Biz') RETURNING id`);
  bizId = biz.rows[0].id;

  pro1 = await seedUser('osa_pro1', 'Professional');
  pro2 = await seedUser('osa_pro2', 'Professional');
  recepNoGrant = await seedUser('osa_recep_no', 'Receptionist');
  recepWithGrant = await seedUser('osa_recep_yes', 'Receptionist');
  clientId = await seedUser('osa_client', 'Client');

  await pool.query(`INSERT INTO calendar_grants (professional_user_id, grantee_user_id) VALUES ($1, $2)`, [
    pro1,
    recepWithGrant,
  ]);

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

describe('own-schedule authz (D-16) via generic schedule_exceptions create', () => {
  test('Admin may create an exception for any in-business professional', async () => {
    currentUser = asUser(100000, 'Admin');
    expect(await createException(pro1, '2026-07-06')).toBe(201);
  });

  test('a Professional may create an exception on their OWN calendar', async () => {
    currentUser = asUser(pro1, 'Professional');
    expect(await createException(pro1, '2026-07-07')).toBe(201);
  });

  test('a Professional may NOT create an exception on a peer professional', async () => {
    currentUser = asUser(pro1, 'Professional');
    expect(await createException(pro2, '2026-07-08')).toBe(403);
  });

  test('a Receptionist WITHOUT a grant is forbidden', async () => {
    currentUser = asUser(recepNoGrant, 'Receptionist');
    expect(await createException(pro1, '2026-07-09')).toBe(403);
  });

  test('a Receptionist WITH a calendar grant for that professional succeeds', async () => {
    currentUser = asUser(recepWithGrant, 'Receptionist');
    expect(await createException(pro1, '2026-07-10')).toBe(201);
  });

  test('a Client can never create a schedule exception', async () => {
    currentUser = asUser(clientId, 'Client');
    expect(await createException(pro1, '2026-07-11')).toBe(403);
  });

  test('a Professional cannot reassign their own exception to a peer via PUT (CR-01)', async () => {
    currentUser = asUser(pro1, 'Professional');
    const createRes = await fetch(`${baseUrl}/api/schedule_exceptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        professional_user_id: String(pro1), resource_id: null, exception_date: '2026-07-20',
        is_unavailable: true, start_time: null, end_time: null, granularity_minutes: null, reason: null,
      }),
    });
    expect(createRes.status).toBe(201);
    const id = ((await createRes.json()) as any).data.id;

    // Reassigning the owner to a peer must be rejected — owner is identity, not editable.
    const putRes = await fetch(`${baseUrl}/api/schedule_exceptions?id=${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        professional_user_id: String(pro2), resource_id: null, exception_date: '2026-07-20',
        is_unavailable: true, start_time: null, end_time: null, granularity_minutes: null, reason: null,
      }),
    });
    expect(putRes.status).toBe(403);
  });
});
