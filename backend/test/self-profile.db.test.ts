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
import { makeApiClient, dataOf, errorOf } from './api_client';
import type { JsonBody } from './api_client';
import type { SelfProfileRow } from '../../shared/src/ssot/query-types';

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
    business_id: bizId, is_active: true, must_change_password: false,
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

  type ProfileResult = { profile: SelfProfileRow };
  // A profile PATCH also echoes the refreshed session user, since email is part of that identity.
  type PatchedProfileResult = ProfileResult & { user: AuthUser };

  const request = makeApiClient(() => baseUrl);
  const reqJson = <T,>(method: 'GET' | 'PATCH', path: string, body?: JsonBody) =>
    request<T>(path, { method, body });

  test('GET returns the caller profile', async () => {
    const res = await reqJson<ProfileResult>('GET', '/api/auth/me/profile');
    expect(res.status).toBe(200);
    expect(dataOf(res).profile.id).toBe(String(proId));
  });

  test('PATCH updates fields and echoes refreshed user email', async () => {
    const res = await reqJson<PatchedProfileResult>('PATCH', '/api/auth/me/profile',
      { display_name: 'Patched', bio: 'b', email: 'patched@x.com', phone: '333' });
    expect(res.status).toBe(200);
    expect(dataOf(res).profile.display_name).toBe('Patched');
    expect(dataOf(res).user.email).toBe('patched@x.com');
  });

  test('PATCH rejects an invalid email -> 400', async () => {
    const res = await reqJson<PatchedProfileResult>('PATCH', '/api/auth/me/profile',
      { display_name: 'X', email: 'not-an-email', phone: null });
    expect(res.status).toBe(400);
  });

  test('PATCH on a duplicate email -> 409', async () => {
    await pool.query(
      `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id)
       VALUES ('other_pro', 'taken@x.com', 'Other', 'h', 's', 'Professional', $1)`,
      [bizId],
    );
    const res = await reqJson<PatchedProfileResult>('PATCH', '/api/auth/me/profile',
      { display_name: 'X', email: 'taken@x.com', phone: null });
    expect(res.status).toBe(409);
  });

  async function makeClient(displayName: string, email: string | null) {
    const row = await pool.query<{ id: string }>(
      `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id)
       VALUES ($1, $2, $3, 'h', 's', 'Client', $4) RETURNING id`,
      [displayName.replace(/\s/g, '_').toLowerCase(), email, displayName, bizId],
    );
    return Number(row.rows[0].id);
  }

  const asClient = (id: number): AuthUser => ({
    id, username: 'client_prof', email: null, role: 'Client',
    business_id: bizId, is_active: true, must_change_password: false,
  });

  test('a client recorded without an email saves their profile without one', async () => {
    const clientId = await makeClient('Sin Email Cliente', null);
    currentUser = asClient(clientId);

    const res = await reqJson<PatchedProfileResult>('PATCH', '/api/auth/me/profile',
      { display_name: 'Sin Email Cliente', phone: '4444' });
    expect(res.status).toBe(200);
    expect(dataOf(res).profile.email).toBeNull();
    expect(dataOf(res).profile.phone).toBe('4444');
  });

  test('a client may add an email later', async () => {
    const clientId = await makeClient('Agrega Email', null);
    currentUser = asClient(clientId);

    const res = await reqJson<PatchedProfileResult>('PATCH', '/api/auth/me/profile',
      { display_name: 'Agrega Email', email: 'agrega@x.com', phone: null });
    expect(res.status).toBe(200);
    expect(dataOf(res).profile.email).toBe('agrega@x.com');
  });

  test('a client who has an email cannot drop it', async () => {
    const clientId = await makeClient('Con Email', 'conemail@x.com');
    currentUser = asClient(clientId);

    const res = await reqJson<PatchedProfileResult>('PATCH', '/api/auth/me/profile',
      { display_name: 'Con Email', email: '', phone: null });
    expect(res.status).toBe(400);
    expect(errorOf(res).detail?.key).toBe('emailFormat');

    const reread = await getSelfProfile(pool, clientId);
    expect(reread!.email).toBe('conemail@x.com');
  });

  test('staff still cannot save a profile without an email', async () => {
    currentUser = asPro(proId);
    const res = await reqJson<PatchedProfileResult>('PATCH', '/api/auth/me/profile',
      { display_name: 'Pro Sin Email', email: '', phone: null });
    expect(res.status).toBe(400);
    expect(errorOf(res).detail?.key).toBe('emailFormat');
  });
});
