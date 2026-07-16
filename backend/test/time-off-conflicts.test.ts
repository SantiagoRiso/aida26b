import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { mountSchedulingRoutes } from '../src/routes/scheduling';
import { mountBusinessClosureRoutes } from '../src/routes/business-closures';
import { mountAppointmentRoutes } from '../src/routes/appointments';
import type { AuthUser } from '../src/auth';

// Exercises the time-off → conflict machinery end-to-end against a real Postgres: the preview count
// (warn-then-confirm dialog) and the per-turno in_conflict flag / conflicting list filter. Both are
// hand-written SQL (AT TIME ZONE, ::time casts, EXISTS) that a typecheck can't validate.
let pool: Pool;
let server: http.Server;
let baseUrl: string;
let currentUser: AuthUser;

const injectUser: express.RequestHandler = (req, _res, next) => {
  (req as express.Request & { user?: AuthUser }).user = currentUser;
  next();
};

type Appt = { id: string; in_conflict?: boolean; conflict_ignored?: boolean };
type Envelope = {
  data?: unknown;
  meta?: { total: number };
  error?: { code: string };
};

async function request(
  path: string,
  { method = 'GET', body }: { method?: string; body?: Record<string, string | number | null> } = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Envelope) : null };
}

// Far future so real-clock now() always sees these as upcoming; local dates in Argentina TZ (−03).
const FUTURE_DATE = '2099-03-04';
const PAST_DATE = '2020-01-01';

let bizId: string;
let adminId: number;
let pro1: number;
let pro2: number;
let clientId: number;
let serviceId: number;

const admin = (): AuthUser => ({
  id: adminId, username: 'admin', email: null, role: 'Admin',
  business_id: Number(bizId), is_active: true, must_change_password: false,
});

async function insertAppt(proId: number, startsAt: string, duration: number, state: string): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO appointments
       (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
     VALUES ($1, $2, $3, $4::timestamptz, $5, $6, '1000.00', false) RETURNING id`,
    [clientId, proId, serviceId, startsAt, duration, state],
  );
  return Number(r.rows[0].id);
}

async function preview(body: Record<string, string | number | null>): Promise<number> {
  currentUser = admin();
  const res = await request('/api/time-off/conflict-preview', { method: 'POST', body });
  expect(res.status).toBe(200);
  return (res.body!.data as { count: number }).count;
}

let futurePro1Id: number;

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const biz = await pool.query<{ id: string }>(`INSERT INTO businesses (name) VALUES ('Conflict Biz') RETURNING id`);
  bizId = biz.rows[0].id;

  const mkPro = async (u: string) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
       VALUES ($1, $2, 'Dr', 'h', 's', 'Professional', $3, false) RETURNING id`,
      [u, `${u}@test.local`, bizId],
    );
    return Number(r.rows[0].id);
  };
  pro1 = await mkPro('cf_pro1');
  pro2 = await mkPro('cf_pro2');

  // A real Admin row — the ignore endpoint writes an in-tx audit with actor_user_id (FK to users).
  const adminRow = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ('cf_admin', 'cf_admin@test.local', 'Admin', 'h', 's', 'Admin', $1, false) RETURNING id`,
    [bizId],
  );
  adminId = Number(adminRow.rows[0].id);

  const cli = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ('cf_cli', 'cf_cli@test.local', 'Cli', 'h', 's', 'Client', $1, false) RETURNING id`,
    [bizId],
  );
  clientId = Number(cli.rows[0].id);

  const svc = await pool.query<{ id: string }>(
    `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
     VALUES ($1, 'Consulta', 60, '1000.00') RETURNING id`,
    [bizId],
  );
  serviceId = Number(svc.rows[0].id);

  // Future open turnos on the same date: pro1 and pro2 at 10:00-11:00 local.
  futurePro1Id = await insertAppt(pro1, `${FUTURE_DATE} 10:00:00-03`, 60, 'scheduled');
  await insertAppt(pro2, `${FUTURE_DATE} 10:00:00-03`, 60, 'scheduled');
  // Past turno (must never count / flag) and a terminal one (not open).
  await insertAppt(pro1, `${PAST_DATE} 10:00:00-03`, 60, 'scheduled');
  await insertAppt(pro1, `${FUTURE_DATE} 10:00:00-03`, 60, 'completed');

  const app = express();
  app.use(express.json());
  const guards = {
    auth: injectUser,
    passwordReady: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    audit: async () => {},
  };
  mountSchedulingRoutes(app, pool, guards);
  mountBusinessClosureRoutes(app, pool, guards);
  mountAppointmentRoutes(app, pool, guards);

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

describe('time-off conflict preview', () => {
  test('full-day business closure counts every future open turno that day (past + terminal excluded)', async () => {
    expect(await preview({ date: FUTURE_DATE })).toBe(2);
  });

  test('personal-exception scope counts only that professional', async () => {
    expect(await preview({ date: FUTURE_DATE, professional_user_id: pro1 })).toBe(1);
  });

  test('partial time-off overlaps by wall-clock; end-exclusive at the boundary', async () => {
    // 10:30-11:30 overlaps the 10:00-11:00 turno.
    expect(await preview({ date: FUTURE_DATE, professional_user_id: pro1, start: '10:30', end: '11:30' })).toBe(1);
    // 11:00-12:00 starts exactly at the turno's end → no overlap.
    expect(await preview({ date: FUTURE_DATE, professional_user_id: pro1, start: '11:00', end: '12:00' })).toBe(0);
  });

  test('a date with no future turnos previews zero', async () => {
    expect(await preview({ date: '2099-03-05' })).toBe(0);
  });
});

describe('in_conflict flag + conflicting filter', () => {
  test('a turno is flagged only while an overlapping closure exists, and auto-clears on delete', async () => {
    const listFuture = async (): Promise<Appt | undefined> => {
      currentUser = admin();
      const res = await request(`/api/appointments?date_from=${FUTURE_DATE}&date_to=2099-03-05&limit=50`);
      expect(res.status).toBe(200);
      return (res.body!.data as Appt[]).find((a) => a.id === String(futurePro1Id));
    };

    expect((await listFuture())?.in_conflict).toBe(false);

    currentUser = admin();
    const created = await request('/api/business-closures', { method: 'POST', body: { exception_date: FUTURE_DATE } });
    expect(created.status).toBe(201);
    const closureId = (created.body!.data as { id: string }).id;

    expect((await listFuture())?.in_conflict).toBe(true);

    // ?conflicting=true returns the two future open turnos (past + terminal excluded).
    currentUser = admin();
    const only = await request('/api/appointments?conflicting=true&limit=50');
    expect(only.status).toBe(200);
    expect((only.body!.data as Appt[]).length).toBe(2);
    expect((only.body!.data as Appt[]).every((a) => a.in_conflict === true)).toBe(true);

    currentUser = admin();
    await request(`/api/business-closures/${closureId}`, { method: 'DELETE' });
    expect((await listFuture())?.in_conflict).toBe(false);
  });

  test('ignoring a conflicting turno drops it from the list + preview; re-flagging restores it', async () => {
    const listConflicting = async (): Promise<Appt[]> => {
      currentUser = admin();
      const res = await request('/api/appointments?conflicting=true&limit=50');
      return res.body!.data as Appt[];
    };
    const isListed = async () => (await listConflicting()).some((a) => a.id === String(futurePro1Id));

    currentUser = admin();
    const created = await request('/api/business-closures', { method: 'POST', body: { exception_date: FUTURE_DATE } });
    const closureId = (created.body!.data as { id: string }).id;
    expect(await isListed()).toBe(true);

    currentUser = admin();
    const ig = await request(`/api/appointments/${futurePro1Id}/ignore-conflict`, { method: 'POST', body: { ignored: true } });
    expect(ig.status).toBe(200);
    expect((ig.body!.data as Appt).conflict_ignored).toBe(true);
    expect(await isListed()).toBe(false);
    // The preview stops counting an ignored turno (only pro2's remains that day).
    expect(await preview({ date: FUTURE_DATE })).toBe(1);

    currentUser = admin();
    const re = await request(`/api/appointments/${futurePro1Id}/ignore-conflict`, { method: 'POST', body: { ignored: false } });
    expect(re.status).toBe(200);
    expect(await isListed()).toBe(true);

    currentUser = admin();
    await request(`/api/business-closures/${closureId}`, { method: 'DELETE' });
  });
});
