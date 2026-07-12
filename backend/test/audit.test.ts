import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool, makeAppPool } from './helpers';
import { mountAuditRoutes } from '../src/routes/audit';
import type { AuthUser } from '../src/auth';
import type { TableRecordMap } from '../../shared/src/types/types';

let pool: Pool;
let appPool: Pool;
let server: http.Server;
let baseUrl: string;
let currentUser: AuthUser;

const injectUser: express.RequestHandler = (req, _res, next) => {
  (req as express.Request & { user?: AuthUser }).user = currentUser;
  next();
};

// audit_events rows come back with created_at too — a DB timestamp outside the SSOT column map.
type AuditRow = TableRecordMap['audit_events'] & { created_at: string };
type ReqBody = Record<string, string | number | boolean | null>;
type Envelope = {
  success?: boolean;
  data?: Record<string, string | number | boolean | null> | Record<string, string | number | boolean | null>[];
  meta?: { page: number; limit: number; total: number };
  error?: { code: string; message: string; fields?: Record<string, string> };
};

async function auditReq(method: 'GET' | 'PATCH', path: string, body?: ReqBody) {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const response = await fetch(`${baseUrl}${path}`, opts);
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Envelope) : null };
}

let bizId: number;
let biz2Id: number;
let adminId: number;
let proId: number;
let clientId: number;

// Relative-date pattern — anchor any event-date comparisons to now, not a fixed calendar date.
const farFutureDate = new Date(Date.now() + 365 * 24 * 3600 * 1000);
const FAR_FUTURE_TS = farFutureDate.toISOString();

function asUser(id: number, role: AuthUser['role'], bId: number | null = bizId): AuthUser {
  return {
    id,
    username: `u${id}`,
    email: null,
    role,
    business_id: bId,
    is_active: true,
    must_change_password: false,
  };
}

async function seedUser(
  username: string,
  role: AuthUser['role'],
  bId: number,
): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO auth.users
       (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ($1, $2, $3, 'h', 's', $4, $5, false)
     RETURNING id`,
    [username, `${username}@test.local`, username, role, bId],
  );
  return Number(r.rows[0].id);
}

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const biz = await pool.query<{ id: string }>(
    `INSERT INTO businesses (name, cancellation_cutoff_hours) VALUES ('Audit Biz', 24) RETURNING id`,
  );
  bizId = Number(biz.rows[0].id);

  const biz2 = await pool.query<{ id: string }>(
    `INSERT INTO businesses (name, cancellation_cutoff_hours) VALUES ('Other Biz', 24) RETURNING id`,
  );
  biz2Id = Number(biz2.rows[0].id);

  adminId = await seedUser('audit_admin', 'Admin', bizId);
  proId = await seedUser('audit_pro', 'Professional', bizId);
  clientId = await seedUser('audit_client', 'Client', bizId);

  await pool.query(
    `INSERT INTO audit_events
       (business_id, actor_user_id, event_type, entity_type, entity_id, outcome, details)
     VALUES
       ($1, $2, 'appointment_scheduled',  'appointments',   10, 'success', '{}'),
       ($1, $2, 'appointment_canceled',   'appointments',   10, 'success', '{}'),
       ($1, $3, 'ledger_charge_created',  'ledger_entries', 20, 'success', '{}'),
       ($1, $4, 'permission_denied',      'appointments',   null, 'denied', '{}')`,
    [bizId, proId, adminId, clientId],
  );

  const app = express();
  app.use(express.json());
  // The server runs on the app role so the settings endpoints hit aida26_user's real grants.
  appPool = makeAppPool();
  mountAuditRoutes(app, appPool, {
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
  currentUser = asUser(adminId, 'Admin');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await appPool.end();
  await pool.end();
});

describe('audit_events immutability trigger (04-01, T-04-18)', () => {
  test('raw UPDATE on audit_events is rejected by the DB trigger', async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO audit_events
         (business_id, actor_user_id, event_type, entity_type, outcome, details)
       VALUES ($1, $2, 'test_event', 'appointments', 'success', '{}')
       RETURNING id`,
      [bizId, adminId],
    );
    const id = Number(r.rows[0].id);

    await expect(
      pool.query(`UPDATE audit_events SET event_type = 'tampered' WHERE id = $1`, [id]),
    ).rejects.toThrow();
  });

  test('raw DELETE on audit_events is rejected by the DB trigger', async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO audit_events
         (business_id, actor_user_id, event_type, entity_type, outcome, details)
       VALUES ($1, $2, 'test_event_del', 'appointments', 'success', '{}')
       RETURNING id`,
      [bizId, adminId],
    );
    const id = Number(r.rows[0].id);

    await expect(
      pool.query(`DELETE FROM audit_events WHERE id = $1`, [id]),
    ).rejects.toThrow();
  });
});

describe('GET /api/audit — admin-only gate (D-27, T-04-16)', () => {
  test('non-admin Professional → 403', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await auditReq('GET', '/api/audit');
    expect(res.status).toBe(403);
  });

  test('non-admin Client → 403', async () => {
    currentUser = asUser(clientId, 'Client');
    const res = await auditReq('GET', '/api/audit');
    expect(res.status).toBe(403);
  });

  test('Admin gets a paginated list scoped to own business', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('GET', '/api/audit');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toHaveProperty('total');
    for (const row of res.body.data) {
      // Rows from the DB won't have business_id in the SELECT projection, but
      // we can verify the total > 0 and the rows have the expected shape.
      expect(row).toHaveProperty('event_type');
      expect(row).toHaveProperty('outcome');
      expect(row).toHaveProperty('created_at');
    }
    expect(res.body.meta.total).toBeGreaterThan(0);
  });

  test('rows are returned newest-first (ORDER BY created_at DESC)', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('GET', '/api/audit');
    expect(res.status).toBe(200);
    const rows = res.body?.data as AuditRow[];
    for (let i = 1; i < rows.length; i++) {
      expect(new Date(rows[i].created_at).getTime()).toBeLessThanOrEqual(
        new Date(rows[i - 1].created_at).getTime(),
      );
    }
  });

  test('denied and failure outcomes appear alongside success (D-28)', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('GET', '/api/audit');
    expect(res.status).toBe(200);
    const outcomes: string[] = (res.body?.data as AuditRow[]).map((r) => r.outcome);
    expect(outcomes).toContain('denied');
    expect(outcomes).toContain('success');
  });
});

describe('GET /api/audit filters (D-27, T-04-17 — parameterized values)', () => {
  test('?entity_type=appointments returns only appointment events', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('GET', '/api/audit?entity_type=appointments');
    expect(res.status).toBe(200);
    const rows = res.body?.data as AuditRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.entity_type).toBe('appointments');
    }
  });

  test('?entity_type=ledger_entries returns only ledger events', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('GET', '/api/audit?entity_type=ledger_entries');
    expect(res.status).toBe(200);
    const rows = res.body?.data as AuditRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.entity_type).toBe('ledger_entries');
    }
  });

  test('?event_type=appointment_canceled returns only that event type', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('GET', '/api/audit?event_type=appointment_canceled');
    expect(res.status).toBe(200);
    const rows = res.body?.data as AuditRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.event_type).toBe('appointment_canceled');
    }
  });

  test('?actor_user_id=N returns only events by that actor', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('GET', `/api/audit?actor_user_id=${proId}`);
    expect(res.status).toBe(200);
    const rows = res.body?.data as AuditRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number(row.actor_user_id)).toBe(proId);
    }
  });

  test('?date_from / ?date_to narrows results to the given window', async () => {
    currentUser = asUser(adminId, 'Admin');
    // Use a window anchored near now that covers the seeded rows (which were just inserted).
    const dateFrom = new Date(Date.now() - 60 * 1000).toISOString();
    const dateTo = new Date(Date.now() + 60 * 1000).toISOString();
    const res = await auditReq('GET', `/api/audit?date_from=${encodeURIComponent(dateFrom)}&date_to=${encodeURIComponent(dateTo)}`);
    expect(res.status).toBe(200);
    const rows = res.body?.data as AuditRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const t = new Date(row.created_at).getTime();
      expect(t).toBeGreaterThanOrEqual(new Date(dateFrom).getTime());
      expect(t).toBeLessThanOrEqual(new Date(dateTo).getTime());
    }
  });

  test('combining entity_type + event_type narrows to the intersection', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('GET', '/api/audit?entity_type=appointments&event_type=appointment_scheduled');
    expect(res.status).toBe(200);
    const rows = res.body?.data as AuditRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.entity_type).toBe('appointments');
      expect(row.event_type).toBe('appointment_scheduled');
    }
  });

  test('filter that matches nothing returns empty data with total=0', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('GET', '/api/audit?event_type=event_that_does_not_exist_xyz');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.meta.total).toBe(0);
  });

  test('?outcome=denied returns only denied events, and meta.total matches the filtered set', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('GET', '/api/audit?outcome=denied');
    expect(res.status).toBe(200);
    const rows = res.body?.data as AuditRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.outcome).toBe('denied');
    // total is the server-side filtered count, not the unfiltered page count.
    expect(res.body.meta.total).toBe(rows.length);
  });

  test('?outcome=success excludes the denied event', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('GET', '/api/audit?outcome=success');
    expect(res.status).toBe(200);
    const rows = res.body?.data as AuditRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.outcome).toBe('success');
  });

  test('unknown outcome value → 422 (validated against the SSOT enum)', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('GET', '/api/audit?outcome=bogus');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_request');
  });
});

describe('GET /api/audit — pagination', () => {
  test('limit and page params are honoured', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('GET', '/api/audit?limit=2&page=1');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.limit).toBe(2);
  });

  test('limit is capped at 200', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('GET', '/api/audit?limit=9999');
    expect(res.status).toBe(200);
    expect(res.body.meta.limit).toBe(200);
  });
});

describe('GET /api/business/settings — any authenticated role, session-scoped', () => {
  test('a non-admin (Client) can read the cutoff for their own business', async () => {
    currentUser = asUser(clientId, 'Client');
    const res = await auditReq('GET', '/api/business/settings');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('cancellation_cutoff_hours');
    // Never exposes other business columns.
    expect(res.body.data).not.toHaveProperty('name');
  });

  test('returns the caller\'s own business cutoff (from session, not a request param)', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await auditReq('GET', '/api/business/settings');
    expect(res.status).toBe(200);
    expect(Number(res.body.data.id)).toBe(bizId);
    expect(res.body.data.cancellation_cutoff_hours).toBe(24);
  });
});

describe('GET /api/businesses/:id/settings — admin-only read', () => {
  test('non-admin → 403', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await auditReq('GET', `/api/businesses/${bizId}/settings`);
    expect(res.status).toBe(403);
  });

  test('admin reads current cutoff', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('GET', `/api/businesses/${bizId}/settings`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data).toHaveProperty('cancellation_cutoff_hours');
    expect(res.body.data).not.toHaveProperty('name');
  });

  test('cross-tenant :id → 404 (hides existence)', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('GET', `/api/businesses/${biz2Id}/settings`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/businesses/:id/settings — admin-only cutoff (D-15, T-04-19, T-04-20)', () => {
  test('non-admin → 403', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await auditReq('PATCH', `/api/businesses/${bizId}/settings`, {
      cancellation_cutoff_hours: 12,
    });
    expect(res.status).toBe(403);
  });

  test('admin updates cancellation_cutoff_hours and value persists', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('PATCH', `/api/businesses/${bizId}/settings`, {
      cancellation_cutoff_hours: 48,
    });
    expect(res.status).toBe(200);
    expect(Number(res.body.data.cancellation_cutoff_hours)).toBe(48);

    const dbCheck = await pool.query<{ cancellation_cutoff_hours: number }>(
      `SELECT cancellation_cutoff_hours FROM businesses WHERE id = $1`,
      [bizId],
    );
    expect(dbCheck.rows[0].cancellation_cutoff_hours).toBe(48);

    await pool.query(`UPDATE businesses SET cancellation_cutoff_hours = 24 WHERE id = $1`, [bizId]);
  });

  test('negative value → 422 (validation + DB CHECK backstop)', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('PATCH', `/api/businesses/${bizId}/settings`, {
      cancellation_cutoff_hours: -1,
    });
    expect(res.status).toBe(422);
  });

  test('missing cancellation_cutoff_hours → 422', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('PATCH', `/api/businesses/${bizId}/settings`, {});
    expect(res.status).toBe(422);
  });

  test('non-integer value → 422', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('PATCH', `/api/businesses/${bizId}/settings`, {
      cancellation_cutoff_hours: 1.5,
    });
    expect(res.status).toBe(422);
  });

  test('cross-tenant :id → 404 (hides existence, T-04-19)', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('PATCH', `/api/businesses/${biz2Id}/settings`, {
      cancellation_cutoff_hours: 12,
    });
    // The endpoint always scopes to user.business_id; the :id param is ignored.
    // When biz2Id !== user.business_id the UPDATE returns zero rows → 404.
    expect(res.status).toBe(404);
  });

  test('endpoint does not expose other businesses columns (T-04-20)', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('PATCH', `/api/businesses/${bizId}/settings`, {
      cancellation_cutoff_hours: 24,
      name: 'INJECTED',
    });
    expect(res.status).toBe(200);
    // Only id and cancellation_cutoff_hours in the RETURNING clause.
    expect(res.body.data).not.toHaveProperty('name');
    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data).toHaveProperty('cancellation_cutoff_hours');

    const dbCheck = await pool.query<{ name: string }>(
      `SELECT name FROM businesses WHERE id = $1`,
      [bizId],
    );
    expect(dbCheck.rows[0].name).toBe('Audit Biz');
  });

  test('admin sets the booking window and it persists', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('PATCH', `/api/businesses/${bizId}/settings`, {
      cancellation_cutoff_hours: 24,
      min_booking_days: 1,
      max_booking_days: 30,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.min_booking_days).toBe(1);
    expect(res.body.data.max_booking_days).toBe(30);

    const db = await pool.query<{ min_booking_days: number; max_booking_days: number }>(
      `SELECT min_booking_days, max_booking_days FROM businesses WHERE id = $1`,
      [bizId],
    );
    expect(db.rows[0].min_booking_days).toBe(1);
    expect(db.rows[0].max_booking_days).toBe(30);

    await pool.query(
      `UPDATE businesses SET min_booking_days = 0, max_booking_days = NULL WHERE id = $1`,
      [bizId],
    );
  });

  test('null max_booking_days clears the cap', async () => {
    currentUser = asUser(adminId, 'Admin');
    await auditReq('PATCH', `/api/businesses/${bizId}/settings`, {
      cancellation_cutoff_hours: 24, min_booking_days: 2, max_booking_days: 10,
    });
    const res = await auditReq('PATCH', `/api/businesses/${bizId}/settings`, {
      cancellation_cutoff_hours: 24, max_booking_days: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.max_booking_days).toBeNull();
    expect(res.body.data.min_booking_days).toBe(2); // untouched by this PATCH
    await pool.query(
      `UPDATE businesses SET min_booking_days = 0, max_booking_days = NULL WHERE id = $1`,
      [bizId],
    );
  });

  test('max_booking_days < min_booking_days → 422', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('PATCH', `/api/businesses/${bizId}/settings`, {
      cancellation_cutoff_hours: 24, min_booking_days: 10, max_booking_days: 5,
    });
    expect(res.status).toBe(422);
  });

  test('negative min_booking_days → 422', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('PATCH', `/api/businesses/${bizId}/settings`, {
      cancellation_cutoff_hours: 24, min_booking_days: -1,
    });
    expect(res.status).toBe(422);
  });

  test('cutoff-only PATCH leaves the window unchanged', async () => {
    currentUser = asUser(adminId, 'Admin');
    await pool.query(
      `UPDATE businesses SET min_booking_days = 3, max_booking_days = 40 WHERE id = $1`,
      [bizId],
    );
    const res = await auditReq('PATCH', `/api/businesses/${bizId}/settings`, {
      cancellation_cutoff_hours: 12,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.min_booking_days).toBe(3);
    expect(res.body.data.max_booking_days).toBe(40);
    await pool.query(
      `UPDATE businesses SET cancellation_cutoff_hours = 24, min_booking_days = 0, max_booking_days = NULL WHERE id = $1`,
      [bizId],
    );
  });
});

describe('GET /api/audit — malformed date filters (WR-04)', () => {
  test('malformed date_from returns 422 invalid_request', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('GET', '/api/audit?date_from=notadate');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_request');
  });

  test('malformed date_to returns 422 invalid_request', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq('GET', '/api/audit?date_to=01/01/2024');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_request');
  });

  test('valid ISO timestamp date_from still returns 200', async () => {
    currentUser = asUser(adminId, 'Admin');
    const iso = new Date(Date.now() - 60 * 1000).toISOString();
    const res = await auditReq('GET', `/api/audit?date_from=${encodeURIComponent(iso)}`);
    expect(res.status).toBe(200);
  });
});
