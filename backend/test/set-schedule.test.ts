import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { mountSetScheduleRoutes } from '../src/routes/set-schedule';
import type { AuthUser } from '../src/auth';

let pool: Pool;
let server: http.Server;
let baseUrl: string;
let currentUser: AuthUser;

const injectUser: express.RequestHandler = (req, _res, next) => {
  (req as express.Request & { user?: AuthUser }).user = currentUser;
  next();
};

async function post(path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as any) : null };
}

let bizId: string;
let proId: number;

const adminUser = (): AuthUser => ({
  id: 100000,
  username: 'admin',
  email: null,
  role: 'Admin',
  business_id: Number(bizId),
  is_active: true,
  must_change_password: false,
});

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const biz = await pool.query<{ id: string }>(`INSERT INTO businesses (name) VALUES ('SetSched Biz') RETURNING id`);
  bizId = biz.rows[0].id;

  const pro = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ('ss_pro', 'ss_pro@test.local', 'Dr. Set', 'h', 's', 'Professional', $1, false) RETURNING id`,
    [bizId]
  );
  proId = Number(pro.rows[0].id);

  const app = express();
  app.use(express.json());
  mountSetScheduleRoutes(app, pool, {
    auth: injectUser,
    passwordReady: (_req, _res, next) => next(),
    audit: async () => {},
  });

  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  currentUser = adminUser();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('POST /api/schedule', () => {
  test('rejects a block whose length is not a whole multiple of its granularity (422 + fields)', async () => {
    const res = await post('/api/schedule', {
      professional_user_id: proId,
      weekly: { mon: [{ start: '09:00', end: '10:00', granularity_minutes: 45 }] },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.fields.weekly).toBeTruthy();
  });

  test('rejects when both professional_user_id and resource_id are set (one-owner rule)', async () => {
    const res = await post('/api/schedule', {
      professional_user_id: proId,
      resource_id: 999,
      weekly: { mon: [{ start: '09:00', end: '12:00', granularity_minutes: 15 }] },
    });
    expect(res.status).toBe(422);
  });

  test('rejects when neither owner is set (one-owner rule)', async () => {
    const res = await post('/api/schedule', {
      weekly: { mon: [{ start: '09:00', end: '12:00', granularity_minutes: 15 }] },
    });
    expect(res.status).toBe(422);
  });

  test('a valid weekly upserts once, then updates on re-POST (no duplicate row)', async () => {
    const first = await post('/api/schedule', {
      professional_user_id: proId,
      weekly: { mon: [{ start: '09:00', end: '12:00', granularity_minutes: 15 }] },
    });
    expect(first.status).toBe(200);

    const second = await post('/api/schedule', {
      professional_user_id: proId,
      weekly: { tue: [{ start: '14:00', end: '17:00', granularity_minutes: 45 }] },
    });
    expect(second.status).toBe(200);

    const count = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM schedules WHERE professional_user_id = $1`,
      [proId]
    );
    expect(count.rows[0].n).toBe('1');

    const row = await pool.query<{ weekly: any }>(
      `SELECT weekly FROM schedules WHERE professional_user_id = $1`,
      [proId]
    );
    expect(row.rows[0].weekly.tue).toBeTruthy();
    expect(row.rows[0].weekly.mon).toBeUndefined();
  });
});
