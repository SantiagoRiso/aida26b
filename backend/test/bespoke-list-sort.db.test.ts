import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { mountLedgerRoutes } from '../src/routes/ledger';
import { mountAuditRoutes } from '../src/routes/audit';
import { mountAppointmentRoutes } from '../src/routes/appointments';
import type { AuthUser } from '../src/auth';
import { makeApiClient, dataOf, metaOf } from './api_client';
import type { AppointmentRow, AuditEventRow, LedgerEntryRow, Wire } from '../../shared/src/ssot/query-types';

// Sorting on the bespoke lists is server-side and allowlisted: the endpoint declares which columns
// it will order by, and anything else falls back to the default order rather than reaching SQL.

let pool: Pool;
let server: http.Server;
let baseUrl: string;
let currentUser: AuthUser;

const injectUser: express.RequestHandler = (req, _res, next) => {
  (req as express.Request & { user?: AuthUser }).user = currentUser;
  next();
};

type LedgerRow = Wire<LedgerEntryRow>;
type AuditRow = Wire<AuditEventRow>;
type ApptRow = Wire<AppointmentRow>;

const request = makeApiClient(() => baseUrl);
const get = <T>(path: string) => request<T>(path, { method: 'GET' });

let bizId: number;
let adminId: number;
let proId: number;
let clientId: number;
let svcId: number;

const BA_TZ = 'America/Argentina/Buenos_Aires';

// Relative to now — never a hardcoded calendar date.
function nextMondayDate(): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  const daysUntilMonday = ((8 - d.getUTCDay()) % 7) || 7;
  d.setUTCDate(d.getUTCDate() + daysUntilMonday);
  return d.toISOString().slice(0, 10);
}
const MONDAY = nextMondayDate();
const mondayAt = (hhmm: string) => `${MONDAY} ${hhmm}:00 ${BA_TZ}`;

async function seedUser(username: string, role: AuthUser['role']): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO auth.users
       (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ($1, $2, $3, 'h', 's', $4, $5, false)
     RETURNING id`,
    [username, `${username}@sort.local`, username, role, bizId],
  );
  return Number(r.rows[0].id);
}

function asUser(id: number, role: AuthUser['role']): AuthUser {
  return { id, username: `u${id}`, email: null, role, business_id: bizId, is_active: true, must_change_password: false };
}

// Every entry shares one created_at so the default order is a single block of ties: only the id
// tiebreaker can tell them apart, which is exactly what paging depends on.
const TIED_ENTRY_COUNT = 12;

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const biz = await pool.query<{ id: string }>(
    `INSERT INTO businesses (name, cancellation_cutoff_hours) VALUES ('Sort Biz', 0) RETURNING id`,
  );
  bizId = Number(biz.rows[0].id);

  adminId = await seedUser('sort_admin', 'Admin');
  proId = await seedUser('sort_pro', 'Professional');
  clientId = await seedUser('sort_client', 'Client');

  const svc = await pool.query<{ id: string }>(
    `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
     VALUES ($1, 'Consulta', 30, '2500.00') RETURNING id`,
    [bizId],
  );
  svcId = Number(svc.rows[0].id);

  // One statement per batch: created_at defaults to the transaction timestamp, so every row in the
  // batch shares it and the default order is a single block of ties. These tables are append-only,
  // so the timestamps cannot be levelled afterwards with an UPDATE.
  await pool.query(
    `INSERT INTO ledger_entries (client_user_id, appointment_id, entry_type, amount_ars, description, actor_user_id)
     SELECT $1, NULL,
            CASE WHEN i % 2 = 0 THEN 'charge' ELSE 'payment' END,
            (100 + i * 10)::numeric,
            'entry ' || i,
            $2
       FROM generate_series(0, $3::int - 1) AS i`,
    [clientId, adminId, TIED_ENTRY_COUNT],
  );

  await pool.query(
    `INSERT INTO audit_events (business_id, actor_user_id, event_type, entity_type, entity_id, outcome, ip, details)
     SELECT $1, $2,
            'evt_' || lpad(($3::int - i)::text, 2, '0'),
            'appointments', i,
            CASE WHEN i % 3 = 0 THEN 'denied' ELSE 'success' END,
            NULL, '{}'::jsonb
       FROM generate_series(0, $3::int - 1) AS i`,
    [bizId, adminId, TIED_ENTRY_COUNT],
  );

  // Appointments: distinct prices and durations, all on the same day.
  for (let i = 0; i < 6; i += 1) {
    await pool.query(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, $4, $5, 'scheduled', $6, false)`,
      [clientId, proId, svcId, mondayAt(`0${i + 1}:00`), 30 + i * 5, String(9000 - i * 100)],
    );
  }

  const app = express();
  app.use(express.json());
  const guards = { auth: injectUser, passwordReady: (_r: express.Request, _s: express.Response, n: express.NextFunction) => n(), audit: async () => {} };
  mountLedgerRoutes(app, pool, guards);
  mountAuditRoutes(app, pool, guards);
  mountAppointmentRoutes(app, pool, guards);

  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  currentUser = asUser(adminId, 'Admin');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

function isSorted(values: string[], dir: 'asc' | 'desc'): boolean {
  const compared = [...values].sort((a, b) => a.localeCompare(b));
  if (dir === 'desc') compared.reverse();
  return values.join('|') === compared.join('|');
}

function numbersSorted(values: number[], dir: 'asc' | 'desc'): boolean {
  const compared = [...values].sort((a, b) => a - b);
  if (dir === 'desc') compared.reverse();
  return values.join('|') === compared.join('|');
}

describe('GET /api/clients/:id/ledger — ordering', () => {
  test('the default order is newest first, closed by the id so ties are deterministic', async () => {
    const res = await get<LedgerRow[]>(`/api/clients/${clientId}/ledger`);
    const ids = dataOf(res).map((r) => Number(r.id));
    expect(ids).toHaveLength(TIED_ENTRY_COUNT);
    expect(numbersSorted(ids, 'desc')).toBe(true);
  });

  test('each declared column actually changes the order the server returns', async () => {
    const asc = await get<LedgerRow[]>(`/api/clients/${clientId}/ledger?sort=amount_ars&dir=asc`);
    const amounts = dataOf(asc).map((r) => Number(r.amount_ars));
    expect(numbersSorted(amounts, 'asc')).toBe(true);

    const desc = await get<LedgerRow[]>(`/api/clients/${clientId}/ledger?sort=amount_ars&dir=desc`);
    expect(numbersSorted(dataOf(desc).map((r) => Number(r.amount_ars)), 'desc')).toBe(true);

    const byType = await get<LedgerRow[]>(`/api/clients/${clientId}/ledger?sort=entry_type&dir=asc`);
    expect(isSorted(dataOf(byType).map((r) => r.entry_type), 'asc')).toBe(true);
  });

  test('an undeclared column falls back to the default order instead of erroring', async () => {
    const fallback = await get<LedgerRow[]>(`/api/clients/${clientId}/ledger?sort=description&dir=asc`);
    expect(fallback.status).toBe(200);
    const def = await get<LedgerRow[]>(`/api/clients/${clientId}/ledger`);
    expect(dataOf(fallback).map((r) => r.id)).toEqual(dataOf(def).map((r) => r.id));
  });

  test('a sort value carrying SQL is answered, not executed', async () => {
    const hostile = encodeURIComponent('id; DROP TABLE ledger_entries--');
    const res = await get<LedgerRow[]>(`/api/clients/${clientId}/ledger?sort=${hostile}`);
    expect(res.status).toBe(200);
    const still = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ledger_entries`);
    expect(Number(still.rows[0].n)).toBe(TIED_ENTRY_COUNT);
  });

  // Every entry shares one created_at, so without the id tiebreaker the pages would be cut out of
  // an unstable order: some entries twice, others never.
  test('paging a column where every value ties still visits every row exactly once', async () => {
    const pageSize = 5;
    const seen: string[] = [];
    for (let page = 1; page <= Math.ceil(TIED_ENTRY_COUNT / pageSize); page += 1) {
      const res = await get<LedgerRow[]>(`/api/clients/${clientId}/ledger?sort=created_at&dir=desc&page=${page}&limit=${pageSize}`);
      expect(metaOf(res).total).toBe(TIED_ENTRY_COUNT);
      seen.push(...dataOf(res).map((r) => r.id));
    }
    expect(seen).toHaveLength(TIED_ENTRY_COUNT);
    expect(new Set(seen).size).toBe(TIED_ENTRY_COUNT);
  });
});

describe('GET /api/audit — ordering', () => {
  test('each declared column actually changes the order the server returns', async () => {
    const byEvent = await get<AuditRow[]>('/api/audit?sort=event_type&dir=asc');
    expect(isSorted(dataOf(byEvent).map((r) => r.event_type), 'asc')).toBe(true);

    const byEventDesc = await get<AuditRow[]>('/api/audit?sort=event_type&dir=desc');
    expect(isSorted(dataOf(byEventDesc).map((r) => r.event_type), 'desc')).toBe(true);

    const byOutcome = await get<AuditRow[]>('/api/audit?sort=outcome&dir=asc');
    expect(isSorted(dataOf(byOutcome).map((r) => r.outcome), 'asc')).toBe(true);
  });

  test('an undeclared column falls back to the default order instead of erroring', async () => {
    const fallback = await get<AuditRow[]>('/api/audit?sort=ip&dir=asc');
    expect(fallback.status).toBe(200);
    const def = await get<AuditRow[]>('/api/audit');
    expect(dataOf(fallback).map((r) => r.id)).toEqual(dataOf(def).map((r) => r.id));
  });

  test('paging a column where every value ties still visits every event exactly once', async () => {
    const pageSize = 5;
    const seen: string[] = [];
    const total = metaOf(await get<AuditRow[]>('/api/audit')).total;
    for (let page = 1; page <= Math.ceil(total / pageSize); page += 1) {
      const res = await get<AuditRow[]>(`/api/audit?sort=created_at&dir=desc&page=${page}&limit=${pageSize}`);
      seen.push(...dataOf(res).map((r) => r.id));
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });
});

describe('GET /api/appointments — ordering', () => {
  test('the default order is chronological', async () => {
    const res = await get<ApptRow[]>('/api/appointments');
    expect(isSorted(dataOf(res).map((r) => r.starts_at), 'asc')).toBe(true);
  });

  test('each declared column actually changes the order the server returns', async () => {
    const byPrice = await get<ApptRow[]>('/api/appointments?sort=price&dir=asc');
    expect(numbersSorted(dataOf(byPrice).map((r) => Number(r.price)), 'asc')).toBe(true);

    const byDuration = await get<ApptRow[]>('/api/appointments?sort=duration_minutes&dir=desc');
    expect(numbersSorted(dataOf(byDuration).map((r) => r.duration_minutes), 'desc')).toBe(true);
  });

  test('an undeclared column falls back to the chronological default', async () => {
    const fallback = await get<ApptRow[]>('/api/appointments?sort=staff_note&dir=desc');
    expect(fallback.status).toBe(200);
    expect(isSorted(dataOf(fallback).map((r) => r.starts_at), 'asc')).toBe(true);
  });

  // A date-range list unions stored rows with virtual occurrences and re-sorts the union in memory;
  // that path must produce the same order as the SQL one, not silently fall back to chronological.
  test('the date-range path honours the same order as the plain one', async () => {
    const ranged = await get<ApptRow[]>(`/api/appointments?date_from=${MONDAY}&date_to=${MONDAY}&sort=price&dir=desc`);
    expect(numbersSorted(dataOf(ranged).map((r) => Number(r.price)), 'desc')).toBe(true);
  });
});
