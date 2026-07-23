import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import type { Server } from 'node:http';
import type express from 'express';
import { createApp } from '../src/app';
import { mountAppointmentRoutes } from '../src/routes/appointments';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool, makeAppPool } from './helpers';
import { makeApiClient, dataOf } from './api_client';
import { currentMondayISO } from '../../shared/src/dev-fixtures';
import type { AuthUser } from '../src/auth';
import type { ConflictVerdict } from '../../shared/src/ssot/domain';

// The headline concurrency guarantee, proven end-to-end: two simultaneous POST /appointments/schedule
// for the same professional and slot must produce exactly ONE appointment; the loser gets a conflict
// verdict, never a second row and never a 500. conflict-recheck.db.test.ts proves the advisory lock
// serializes the read-only recheck; this proves the full save path (recheck + INSERT + commit) holds
// the same lock across the read-decide-write span, so the property survives a real write, not just a
// preview.
//
// Racing strategy — a services-table barrier, not luck. Every schedule request reads `services`
// (getServiceDefaults) before it ever reaches the per-owner advisory lock. Holding
// ACCESS EXCLUSIVE on `services` therefore parks BOTH requests at an identical point that sits
// *before* the lock, in both the correct and the lock-removed builds. Releasing it launches them
// together: with the lock present, one wins the advisory lock and the other blocks behind it until
// the first commits (→ one row); with the lock removed, both sail past the (absent) lock, both read
// an empty schedule, and both insert (→ two rows). That asymmetry is what makes this a real guard —
// weakening recheckConflictsInTx's acquireOwnerLock turns it red. Verified by commenting the lock
// out: this test then reports two appointments.

let testsPool: Pool;
let appPool: Pool;
let server: Server;
const request = makeApiClient(() => apiBase);
let apiBase = '';

let businessId: string;
let professionalUserId: number;
let clientUserId: number;
let serviceId: number;

// A future Monday (this week's Monday + 7d) so the slot is never in the past regardless of the run
// date; the block below is keyed to 'mon'. No hardcoded calendar date, per the project principle.
function nextMondayISO(): string {
  const [y, m, d] = currentMondayISO().split('-').map(Number);
  const dt = new Date(y, m - 1, d + 7);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}
const MONDAY = nextMondayISO();

const scheduleBody = () => ({
  professional_user_id: professionalUserId,
  service_id: serviceId,
  client_user_id: clientUserId,
  date: MONDAY,
  start: '09:00',
  duration_minutes: 15,
});

// Count the app backends parked (ungranted) waiting on the `services` lock. Our own barrier holds a
// granted ACCESS EXCLUSIVE, excluded by NOT granted; each blocked request adds one ACCESS SHARE row.
async function waitersOnServices(): Promise<number> {
  const { rows } = await testsPool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_locks
      WHERE relation = 'services'::regclass AND NOT granted`,
  );
  return rows[0].n;
}

async function waitForBothParked(expected: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await waitersOnServices()) >= expected) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${expected} requests to park on the services lock`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  await resetTestDb();
  testsPool = makeTestPool();
  await runMigrations(testsPool, DEFAULT_MIGRATIONS_DIR);

  const biz = await testsPool.query<{ id: string }>(
    `INSERT INTO businesses (name) VALUES ('Race Biz') RETURNING id`,
  );
  businessId = biz.rows[0].id;

  const admin = await testsPool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id)
     VALUES ('race_admin', 'race_admin@test.local', 'Race Admin', 'h', 's', 'Admin', $1) RETURNING id`,
    [businessId],
  );
  const defaultUser: AuthUser = {
    id: Number(admin.rows[0].id),
    username: 'race_admin',
    email: 'race_admin@test.local',
    role: 'Admin',
    business_id: Number(businessId),
    is_active: true,
    must_change_password: false,
  };

  const pro = await testsPool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ('race_pro', 'race_pro@test.local', 'Dr. Race', 'h', 's', 'Professional', $1, false) RETURNING id`,
    [businessId],
  );
  professionalUserId = Number(pro.rows[0].id);

  const client = await testsPool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ('race_client', 'race_client@test.local', 'Race Client', 'h', 's', 'Client', $1, false) RETURNING id`,
    [businessId],
  );
  clientUserId = Number(client.rows[0].id);

  const svc = await testsPool.query<{ id: string }>(
    `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
     VALUES ($1, 'Consulta', 15, '1000.00') RETURNING id`,
    [businessId],
  );
  serviceId = Number(svc.rows[0].id);

  const block = await testsPool.query<{ id: string }>(
    `INSERT INTO schedule_blocks (professional_user_id, weekday, start_time, end_time)
     VALUES ($1, 'mon', '09:00', '12:00') RETURNING id`,
    [professionalUserId],
  );
  await testsPool.query(
    `INSERT INTO schedule_block_services (professional_user_id, schedule_block_id, service_id)
     VALUES ($1, $2, $3)`,
    [professionalUserId, block.rows[0].id, serviceId],
  );

  appPool = makeAppPool();
  // createApp injects `defaultUser` into req.user before domain routes run, so the appointment
  // guards are pass-throughs and audit is a no-op — the concern here is the DB race, not auth.
  const passThrough: express.RequestHandler = (_req, _res, next) => next();
  const app = createApp(appPool, {
    defaultUser,
    mountDomainRoutes: (a) =>
      mountAppointmentRoutes(a, appPool, {
        auth: passThrough,
        passwordReady: passThrough,
        audit: async () => {},
      }),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  apiBase = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await appPool.end();
  await testsPool.end();
});

describe('POST /appointments/schedule — concurrent same-slot bookings', () => {
  test('two simultaneous bookings for one professional/slot yield exactly one appointment', async () => {
    // Park both requests before the advisory lock, then release them together (see header).
    const barrier: PoolClient = await testsPool.connect();
    await barrier.query('BEGIN');
    await barrier.query('LOCK TABLE services IN ACCESS EXCLUSIVE MODE');

    const bothFired = Promise.all([
      request<ConflictVerdict>('/appointments/schedule', { method: 'POST', body: scheduleBody() }),
      request<ConflictVerdict>('/appointments/schedule', { method: 'POST', body: scheduleBody() }),
    ]);

    try {
      await waitForBothParked(2);
    } finally {
      await barrier.query('COMMIT');
      barrier.release();
    }

    const [a, b] = await bothFired;

    // Neither request may 500 — a lost race is a clean verdict, not a crash.
    expect(a.status).not.toBe(500);
    expect(b.status).not.toBe(500);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 201]);

    const winner = a.status === 201 ? a : b;
    const loser = a.status === 201 ? b : a;

    // Winner booked a real row.
    // eslint-disable-next-line no-restricted-syntax -- boundary: a 201 booking returns the created appointment row, not the ConflictVerdict shape this client is generically typed for
    const appt = dataOf(winner) as unknown as { id: string };
    expect(appt.id).toBeTruthy();

    // Loser got a conflict-shaped verdict: the slot it saw was already taken.
    const verdict = dataOf(loser);
    expect(verdict.can_save).toBe(false);
    expect(verdict.requires_override).toBe(true);
    expect(verdict.conflicts.some((c) => c.type === 'professional_overlap')).toBe(true);

    // The invariant: exactly one appointment exists for this professional/slot.
    const { rows } = await testsPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM appointments
        WHERE professional_user_id = $1
          AND (starts_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = $2::date`,
      [professionalUserId, MONDAY],
    );
    expect(rows[0].n).toBe(1);
  });
});
