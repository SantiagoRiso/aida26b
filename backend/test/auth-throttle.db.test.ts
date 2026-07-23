import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool, makeAppPool } from './helpers';
import { mountAuthRoutes } from '../src/routes/auth';
import { createAuditWriter } from '../src/audit';
import { AuthThrottle } from '../src/auth-throttle';
import { hashPassword } from '../src/auth';
import { makeApiClient, dataOf, errorOf } from './api_client';
import type { AuthUser } from '../src/auth';

// The throttle runs on an injected clock, so accumulation never races real elapsed time — 5-6
// scrypt-backed login round-trips can outrun a short real window and drop the oldest attempts out of
// it, which is exactly the flake this avoids — and the release test advances the clock instead of
// sleeping.
const WINDOW_MS = 60_000;
const CLOCK_BASE = 1_000_000;
let clockMs = CLOCK_BASE;

const REAL_USERNAME = 'throttle_real_user';
const REAL_PASSWORD = 'correct-horse-battery';
const UNKNOWN_USERNAME = 'throttle_no_such_user';

let pool: Pool;
let appPool: Pool;
let server: http.Server;
let baseUrl: string;
let throttle: AuthThrottle;
let bizId: number;
let realUserId: number;

const request = makeApiClient(() => baseUrl);

type LoginResult = { user: AuthUser };

function login(username: string, password: string) {
  return request<LoginResult>('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
}

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
  appPool = makeAppPool();

  const biz = await pool.query<{ id: string }>(
    `INSERT INTO businesses (name) VALUES ('Throttle Biz') RETURNING id`,
  );
  bizId = Number(biz.rows[0].id);

  const { passwordHash, passwordSalt } = await hashPassword(REAL_PASSWORD);
  const user = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id)
     VALUES ($1, 'throttle@test.local', 'Throttle User', $2, $3, 'Professional', $4)
     RETURNING id`,
    [REAL_USERNAME, passwordHash, passwordSalt, bizId],
  );
  realUserId = Number(user.rows[0].id);

  throttle = new AuthThrottle({ windowMs: WINDOW_MS, now: () => clockMs });

  const app = express();
  app.use(express.json());
  mountAuthRoutes(app, appPool, {
    audit: createAuditWriter(appPool),
    requireAuth: (_req, _res, next) => next(),
    throttle,
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 30000);

// audit_events is append-only (trigger-enforced), so tests can't clear it between runs — they
// read only what was written after this watermark instead.
async function auditWatermark(): Promise<number> {
  const { rows } = await pool.query<{ max: string | null }>(`SELECT max(id)::text AS max FROM audit_events`);
  return Number(rows[0].max ?? 0);
}

beforeEach(() => {
  // Every request in this file arrives from the same loopback address, so without this the
  // per-client budget would carry across tests. Reset the clock too so each test starts fresh.
  throttle.reset();
  clockMs = CLOCK_BASE;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await appPool.end();
  await pool.end();
});

describe('login throttling', () => {
  test('the sixth failed attempt on one username is refused without checking credentials', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await login(REAL_USERNAME, 'wrong-password');
      expect(res.status).toBe(401);
    }

    const blocked = await login(REAL_USERNAME, 'wrong-password');
    expect(blocked.status).toBe(429);
    expect(errorOf(blocked).code).toBe('too_many_attempts');
  });

  test('a throttled client is refused even when it finally sends the right password', async () => {
    for (let i = 0; i < 5; i++) await login(REAL_USERNAME, 'wrong-password');

    const blocked = await login(REAL_USERNAME, REAL_PASSWORD);
    expect(blocked.status).toBe(429);
    expect(blocked.cookie).toBeNull();
  });

  test('the block releases once the window elapses, and the right password then works', async () => {
    for (let i = 0; i < 5; i++) await login(REAL_USERNAME, 'wrong-password');
    expect((await login(REAL_USERNAME, REAL_PASSWORD)).status).toBe(429);

    // Advance past the window; the oldest failures age out and the block lifts.
    clockMs += WINDOW_MS + 1;

    const allowed = await login(REAL_USERNAME, REAL_PASSWORD);
    expect(allowed.status).toBe(200);
    expect(dataOf(allowed).user.id).toBe(realUserId);
    expect(allowed.cookie).not.toBeNull();
  });

  test('a successful login clears that username budget so the next typo is not pre-blocked', async () => {
    for (let i = 0; i < 4; i++) await login(REAL_USERNAME, 'wrong-password');

    expect((await login(REAL_USERNAME, REAL_PASSWORD)).status).toBe(200);

    for (let i = 0; i < 4; i++) {
      expect((await login(REAL_USERNAME, 'wrong-password')).status).toBe(401);
    }
  });

  test('carries a Retry-After the client can honour', async () => {
    for (let i = 0; i < 5; i++) await login(REAL_USERNAME, 'wrong-password');

    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: REAL_USERNAME, password: 'wrong-password' }),
    });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('throttling is not an account-existence oracle', () => {
  // The whole point of the dummy-hash path in routes/auth.ts is that a caller cannot tell a real
  // username from an invented one. A throttle that engaged at a different attempt count, returned
  // a different code, or carried a different body for the two would hand back exactly that.
  test('a real and an unknown username throttle at the same attempt with the same response', async () => {
    async function attemptSeries(username: string) {
      const statuses: number[] = [];
      const bodies: string[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await login(username, 'wrong-password');
        statuses.push(res.status);
        bodies.push(JSON.stringify(res.body));
      }
      return { statuses, bodies };
    }

    const real = await attemptSeries(REAL_USERNAME);
    throttle.reset();
    const unknown = await attemptSeries(UNKNOWN_USERNAME);

    expect(real.statuses).toEqual([401, 401, 401, 401, 401, 429]);
    expect(unknown.statuses).toEqual(real.statuses);
    expect(unknown.bodies).toEqual(real.bodies);
  });

  test('one username being throttled does not throttle a different one from the same client', async () => {
    for (let i = 0; i < 5; i++) await login(REAL_USERNAME, 'wrong-password');
    expect((await login(REAL_USERNAME, 'wrong-password')).status).toBe(429);

    // A different username still gets the ordinary 401 — the block is scoped to what was tried,
    // so it never reports anything about the account named in a fresh request.
    expect((await login(UNKNOWN_USERNAME, 'wrong-password')).status).toBe(401);
  });
});

describe('failed attempts on unknown usernames are recorded', () => {
  type AuditRow = { business_id: string | null; actor_user_id: string | null; details: { username?: string } };

  async function loginFailuresSince(since: number, username: string) {
    const { rows } = await pool.query<AuditRow>(
      `SELECT business_id, actor_user_id, details
         FROM audit_events
        WHERE id > $1 AND event_type = 'login_failed' AND details->>'username' = $2`,
      [since, username],
    );
    return rows;
  }

  test('an attempt on a username nobody holds lands in audit_events with no business', async () => {
    const since = await auditWatermark();
    await login(UNKNOWN_USERNAME, 'wrong-password');

    const rows = await loginFailuresSince(since, UNKNOWN_USERNAME);
    expect(rows).toHaveLength(1);
    expect(rows[0].business_id).toBeNull();
    expect(rows[0].actor_user_id).toBeNull();
    expect(rows[0].details.username).toBe(UNKNOWN_USERNAME);
  });

  test('an attempt on a real account still carries that account and its business', async () => {
    const since = await auditWatermark();
    await login(REAL_USERNAME, 'wrong-password');

    const rows = await loginFailuresSince(since, REAL_USERNAME);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].business_id)).toBe(bizId);
    expect(Number(rows[0].actor_user_id)).toBe(realUserId);
  });

  test('throttled attempts stop adding rows, so the trail cannot be flooded', async () => {
    const since = await auditWatermark();
    for (let i = 0; i < 12; i++) await login(UNKNOWN_USERNAME, 'wrong-password');

    // Five failures were audited; the seven refusals after them were not.
    const rows = await loginFailuresSince(since, UNKNOWN_USERNAME);
    expect(rows).toHaveLength(5);
  });
});
