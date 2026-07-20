import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import type { AuthUser } from '../src/auth';
import { mountAuthRoutes } from '../src/routes/auth';
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

describe('me/profile HTTP', () => {
  let server: http.Server;
  let baseUrl: string;
  let currentUser: AuthUser | undefined;
  const injectUser: express.RequestHandler = (req, _res, next) => {
    (req as express.Request & { user?: AuthUser }).user = currentUser;
    next();
  };
  const asPro = (id: number): AuthUser => ({
    id, username: 'pro_prof', email: 'x@x.com', role: 'Professional',
    business_id: String(bizId), is_active: true, must_change_password: false,
  });

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    mountAuthRoutes(app, pool, { audit: async () => {}, requireAuth: injectUser });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    currentUser = asPro(proId);
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  async function reqJson(method: string, path: string, body?: object) {
    const res = await fetch(`${baseUrl}${path}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  test('GET returns the caller profile', async () => {
    const res = await reqJson('GET', '/api/auth/me/profile');
    expect(res.status).toBe(200);
    expect(res.body.data.profile.id).toBe(String(proId));
  });

  test('PATCH updates fields and echoes refreshed user email', async () => {
    const res = await reqJson('PATCH', '/api/auth/me/profile',
      { display_name: 'Patched', bio: 'b', email: 'patched@x.com', phone: '333' });
    expect(res.status).toBe(200);
    expect(res.body.data.profile.display_name).toBe('Patched');
    expect(res.body.data.user.email).toBe('patched@x.com');
  });

  test('PATCH rejects an invalid email -> 400', async () => {
    const res = await reqJson('PATCH', '/api/auth/me/profile',
      { display_name: 'X', email: 'not-an-email', phone: null });
    expect(res.status).toBe(400);
  });

  test('PATCH on a duplicate email -> 409', async () => {
    await pool.query(
      `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id)
       VALUES ('other_pro', 'taken@x.com', 'Other', 'h', 's', 'Professional', $1)`,
      [bizId],
    );
    const res = await reqJson('PATCH', '/api/auth/me/profile',
      { display_name: 'X', email: 'taken@x.com', phone: null });
    expect(res.status).toBe(409);
  });
});
