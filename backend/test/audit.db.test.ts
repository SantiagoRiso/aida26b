import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool, makeAppPool } from './helpers';
import { mountAuditRoutes } from '../src/routes/audit';
import { mountBusinessSettingsRoutes } from '../src/routes/business-settings';
import type { AuthUser } from '../src/auth';
import { makeApiClient, dataOf, errorOf, metaOf } from './api_client';
import { BUSINESS_TZ, addDaysISO } from '../src/time';
import type { JsonBody } from './api_client';
import type { AuditEventRow, BusinessSettingsRow, Wire } from '../../shared/src/ssot/query-types';

let pool: Pool;
let appPool: Pool;
let server: http.Server;
let baseUrl: string;
let currentUser: AuthUser;

const injectUser: express.RequestHandler = (req, _res, next) => {
  (req as express.Request & { user?: AuthUser }).user = currentUser;
  next();
};

type AuditRow = Wire<AuditEventRow>;
type ReqBody = JsonBody;

const request = makeApiClient(() => baseUrl);

function auditReq<T>(method: 'GET' | 'PATCH', path: string, body?: ReqBody) {
  return request<T>(path, { method, body });
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
  const testGuards = {
    auth: injectUser,
    passwordReady: ((_req, _res, next) => next()) as express.RequestHandler,
    audit: async () => {},
  };
  mountAuditRoutes(app, appPool, testGuards);
  mountBusinessSettingsRoutes(app, appPool, testGuards);

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

describe('audit_events immutability trigger', () => {
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

describe('GET /api/audit — admin-only gate', () => {
  test('non-admin Professional → 403', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await auditReq<AuditRow[]>('GET', '/api/audit');
    expect(res.status).toBe(403);
  });

  test('non-admin Client → 403', async () => {
    currentUser = asUser(clientId, 'Client');
    const res = await auditReq<AuditRow[]>('GET', '/api/audit');
    expect(res.status).toBe(403);
  });

  test('Admin gets a paginated list scoped to own business', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<AuditRow[]>('GET', '/api/audit');
    expect(res.status).toBe(200);
    expect(Array.isArray(dataOf(res))).toBe(true);
    expect(metaOf(res)).toHaveProperty('total');
    for (const row of dataOf(res)) {
      // Rows from the DB won't have business_id in the SELECT projection, but
      // we can verify the total > 0 and the rows have the expected shape.
      expect(row).toHaveProperty('event_type');
      expect(row).toHaveProperty('outcome');
      expect(row).toHaveProperty('created_at');
    }
    expect(metaOf(res).total).toBeGreaterThan(0);
  });

  test('rows are returned newest-first (ORDER BY created_at DESC)', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<AuditRow[]>('GET', '/api/audit');
    expect(res.status).toBe(200);
    const rows = dataOf(res);
    for (let i = 1; i < rows.length; i++) {
      expect(new Date(rows[i].created_at).getTime()).toBeLessThanOrEqual(
        new Date(rows[i - 1].created_at).getTime(),
      );
    }
  });

  test('denied and failure outcomes appear alongside success', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<AuditRow[]>('GET', '/api/audit');
    expect(res.status).toBe(200);
    const outcomes: string[] = (dataOf(res)).map((r) => r.outcome);
    expect(outcomes).toContain('denied');
    expect(outcomes).toContain('success');
  });
});

describe('GET /api/audit filters (parameterized values)', () => {
  test('?entity_type=appointments returns only appointment events', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<AuditRow[]>('GET', '/api/audit?filter_entity_type=appointments');
    expect(res.status).toBe(200);
    const rows = dataOf(res);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.entity_type).toBe('appointments');
    }
  });

  test('?entity_type=ledger_entries returns only ledger events', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<AuditRow[]>('GET', '/api/audit?filter_entity_type=ledger_entries');
    expect(res.status).toBe(200);
    const rows = dataOf(res);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.entity_type).toBe('ledger_entries');
    }
  });

  test('?event_type=appointment_canceled returns only that event type', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<AuditRow[]>('GET', '/api/audit?filter_event_type=appointment_canceled');
    expect(res.status).toBe(200);
    const rows = dataOf(res);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.event_type).toBe('appointment_canceled');
    }
  });

  test('?actor_user_id=N returns only events by that actor', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<AuditRow[]>('GET', `/api/audit?filter_actor_user_id=${proId}`);
    expect(res.status).toBe(200);
    const rows = dataOf(res);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number(row.actor_user_id)).toBe(proId);
    }
  });

  // An id says which record changed; it never says whose account or whose turno, which is the
  // question a reader of the log actually has.
  describe('naming what the event was about', () => {
    test('a user event names the account, and a client with no login falls back to their name', async () => {
      const contactOnly = await pool.query<{ id: string }>(
        `INSERT INTO auth.users
           (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
         VALUES (NULL, NULL, 'Homero Sin Login', 'h', 's', 'Client', $1, false)
         RETURNING id`,
        [bizId],
      );
      const contactOnlyId = Number(contactOnly.rows[0].id);
      await pool.query(
        `INSERT INTO audit_events
           (business_id, actor_user_id, event_type, entity_type, entity_id, outcome, details)
         VALUES ($1, $2, 'password_reset', 'auth.users', $3, 'success', '{}'),
                ($1, $2, 'user_deactivated', 'auth.users', $4, 'success', '{}')`,
        [bizId, adminId, proId, contactOnlyId],
      );

      currentUser = asUser(adminId, 'Admin');
      const rows = dataOf(await auditReq<AuditRow[]>('GET', '/api/audit?filter_event_type=password_reset'));
      expect(rows.find((r) => Number(r.entity_id) === proId)?.entity_label).toBe('audit_pro');

      const deact = dataOf(await auditReq<AuditRow[]>('GET', '/api/audit?filter_event_type=user_deactivated'));
      expect(deact.find((r) => Number(r.entity_id) === contactOnlyId)?.entity_label).toBe('Homero Sin Login');
    });

    test('a turno is named by whose it is and when, not by its id', async () => {
      const svc = await pool.query<{ id: string }>(
        `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
         VALUES ($1, 'Consulta auditada', 30, '1500.00') RETURNING id`,
        [bizId],
      );
      const svcId = Number(svc.rows[0].id);
      const appt = await pool.query<{ id: string }>(
        `INSERT INTO appointments
           (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
         VALUES ($1, $2, $3, $4, 30, 'scheduled', '1500.00', false)
         RETURNING id`,
        [clientId, proId, svcId, FAR_FUTURE_TS],
      );
      const apptId = Number(appt.rows[0].id);
      await pool.query(
        `INSERT INTO audit_events
           (business_id, actor_user_id, event_type, entity_type, entity_id, outcome, details)
         VALUES ($1, $2, 'appointment_canceled_named', 'appointments', $3, 'success', '{}')`,
        [bizId, adminId, apptId],
      );

      currentUser = asUser(adminId, 'Admin');
      const rows = dataOf(await auditReq<AuditRow[]>('GET', '/api/audit?filter_event_type=appointment_canceled_named'));
      const label = rows[0]?.entity_label ?? '';
      expect(label).toContain('audit_client');
      // Wall clock in the business timezone, so the reader sees the turno's local time.
      expect(label).toMatch(/\d{2}\/\d{2} \d{2}:\d{2}$/);
    });

    test('an entity with no natural name keeps its id rather than an invented label', async () => {
      await pool.query(
        `INSERT INTO audit_events
           (business_id, actor_user_id, event_type, entity_type, entity_id, outcome, details)
         VALUES ($1, $2, 'grant_created_named', 'calendar_grants', 4242, 'success', '{}')`,
        [bizId, adminId],
      );
      currentUser = asUser(adminId, 'Admin');
      const rows = dataOf(await auditReq<AuditRow[]>('GET', '/api/audit?filter_event_type=grant_created_named'));
      expect(rows[0].entity_label).toBeNull();
      expect(Number(rows[0].entity_id)).toBe(4242);
    });

    // The generic engine stamps the SSoT table key, so editing a client writes entity_type
    // 'clients' rather than 'auth.users'. Both name the same person row, and the log used to show
    // only the table's title for the first.
    test.each(['clients', 'professionals'])(
      'a generic write stamped %s names the person, like the account routes already did',
      async (entityType) => {
        const eventType = `generic_write_named_${entityType}`;
        await pool.query(
          `INSERT INTO audit_events
             (business_id, actor_user_id, event_type, entity_type, entity_id, outcome, details)
           VALUES ($1, $2, $3, $4, $5, 'success', '{}')`,
          [bizId, adminId, eventType, entityType, clientId],
        );

        currentUser = asUser(adminId, 'Admin');
        const rows = dataOf(await auditReq<AuditRow[]>('GET', `/api/audit?filter_event_type=${eventType}`));
        expect(rows[0]?.entity_label).toBe('audit_client');
      },
    );

    // A ledger row says who paid or who was charged, which the id alone never does.
    test('a ledger charge with no appointment names just the client, with no dangling separator', async () => {
      const entry = await pool.query<{ id: string }>(
        `INSERT INTO ledger_entries (client_user_id, entry_type, amount_ars, actor_user_id)
         VALUES ($1, 'charge', '1000.00', $2) RETURNING id`,
        [clientId, adminId],
      );
      const entryId = Number(entry.rows[0].id);
      await pool.query(
        `INSERT INTO audit_events
           (business_id, actor_user_id, event_type, entity_type, entity_id, outcome, details)
         VALUES ($1, $2, 'ledger_charge_created_named_noappt', 'ledger_entries', $3, 'success', '{}')`,
        [bizId, adminId, entryId],
      );

      currentUser = asUser(adminId, 'Admin');
      const rows = dataOf(await auditReq<AuditRow[]>('GET', '/api/audit?filter_event_type=ledger_charge_created_named_noappt'));
      expect(rows[0]?.entity_label).toBe('audit_client');
    });

    test('a ledger charge tied to an appointment also names the service and when it was', async () => {
      const svc = await pool.query<{ id: string }>(
        `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
         VALUES ($1, 'Sesión facturada', 30, '1200.00') RETURNING id`,
        [bizId],
      );
      const svcId = Number(svc.rows[0].id);
      const appt = await pool.query<{ id: string }>(
        `INSERT INTO appointments
           (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
         VALUES ($1, $2, $3, $4, 30, 'scheduled', '1200.00', false)
         RETURNING id`,
        [clientId, proId, svcId, FAR_FUTURE_TS],
      );
      const apptId = Number(appt.rows[0].id);
      const entry = await pool.query<{ id: string }>(
        `INSERT INTO ledger_entries (client_user_id, appointment_id, entry_type, amount_ars, actor_user_id)
         VALUES ($1, $2, 'charge', '1200.00', $3) RETURNING id`,
        [clientId, apptId, adminId],
      );
      const entryId = Number(entry.rows[0].id);
      await pool.query(
        `INSERT INTO audit_events
           (business_id, actor_user_id, event_type, entity_type, entity_id, outcome, details)
         VALUES ($1, $2, 'ledger_charge_created_named_withappt', 'ledger_entries', $3, 'success', '{}')`,
        [bizId, adminId, entryId],
      );

      currentUser = asUser(adminId, 'Admin');
      const rows = dataOf(await auditReq<AuditRow[]>('GET', '/api/audit?filter_event_type=ledger_charge_created_named_withappt'));
      const label = rows[0]?.entity_label ?? '';
      expect(label).toContain('audit_client');
      expect(label).toContain('Sesión facturada');
      // Wall clock in the business timezone, matching how a turno's own audit row is formatted.
      expect(label).toMatch(/\d{2}\/\d{2} \d{2}:\d{2}$/);
    });

    // The ledger joins (entry -> client, entry -> appointment -> service) all key off a primary
    // key, so a ledger audit row must still be exactly one row in the page total, not duplicated.
    test('meta.total for ledger rows matches an independent count (join-multiplication guard)', async () => {
      currentUser = asUser(adminId, 'Admin');
      const res = await auditReq<AuditRow[]>('GET', '/api/audit?filter_entity_type=ledger_entries&limit=1&page=1');
      expect(res.status).toBe(200);
      const independent = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_events WHERE business_id = $1 AND entity_type = 'ledger_entries'`,
        [bizId],
      );
      expect(metaOf(res).total).toBe(Number(independent.rows[0].n));
    });
  });

  test('every row carries the actor username, resolved from the directory', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<AuditRow[]>('GET', `/api/audit?filter_actor_user_id=${proId}`);
    const rows = dataOf(res);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.actor_username).toBe('audit_pro');
    }
  });

  test('?filter_actor_username=name selects the same events as that actor\'s id', async () => {
    currentUser = asUser(adminId, 'Admin');
    const byName = await auditReq<AuditRow[]>('GET', '/api/audit?filter_actor_username=audit_pro');
    expect(byName.status).toBe(200);
    const byId = await auditReq<AuditRow[]>('GET', `/api/audit?filter_actor_user_id=${proId}`);
    expect(dataOf(byName).map((r) => r.id)).toEqual(dataOf(byId).map((r) => r.id));
    expect(metaOf(byName).total).toBe(metaOf(byId).total);
  });

  // The paged rows and the reported total have to agree: a filter that only the page applies
  // would report a count the caller can never page through.
  test('a username filter matching nobody reports a total of zero, not the unfiltered count', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<AuditRow[]>('GET', '/api/audit?filter_actor_username=nobody_at_all');
    expect(res.status).toBe(200);
    expect(dataOf(res)).toEqual([]);
    expect(metaOf(res).total).toBe(0);
  });

  // Whoever reads the log is looking for a person, and they know a name, not an exact login. The
  // seeded actors elsewhere in this file carry display_name = username, which cannot tell the two
  // columns apart, so this actor is deliberately given a name unlike its login.
  describe('searching the actor by a fragment of the name or the login', () => {
    let searchActorId: number;

    beforeAll(async () => {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO auth.users
           (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
         VALUES ('lsimpson_audit', 'lsimpson_audit@test.local', 'Dra. Lisa Simpson', 'h', 's', 'Professional', $1, false)
         RETURNING id`,
        [bizId],
      );
      searchActorId = Number(r.rows[0].id);
      await pool.query(
        `INSERT INTO audit_events
           (business_id, actor_user_id, event_type, entity_type, entity_id, outcome, details)
         VALUES ($1, $2, 'appointment_scheduled', 'appointments', 77, 'success', '{}')`,
        [bizId, searchActorId],
      );
    });

    async function search(term: string) {
      currentUser = asUser(adminId, 'Admin');
      return auditReq<AuditRow[]>('GET', `/api/audit?filter_actor_username=${encodeURIComponent(term)}`);
    }

    test('a fragment of the login finds the actor, without naming it in full', async () => {
      const res = await search('simpson_aud');
      expect(res.status).toBe(200);
      const rows = dataOf(res);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(Number(row.actor_user_id)).toBe(searchActorId);
    });

    test('a fragment of the display name finds it too, though the column shown is the login', async () => {
      const res = await search('Lisa');
      const rows = dataOf(res);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.actor_username).toBe('lsimpson_audit');
    });

    test('the search ignores case', async () => {
      expect(metaOf(await search('lISA')).total).toBe(metaOf(await search('Lisa')).total);
    });

    // A search box that let its input act as a pattern would answer a question nobody asked:
    // `_` would quietly match any character, so `l_simpson` must find nothing rather than everything.
    test("a wildcard the reader typed is matched literally, not as a pattern", async () => {
      expect(metaOf(await search('l_simpson')).total).toBe(0);
      expect(metaOf(await search('%')).total).toBe(0);
    });

    test('negating the search returns exactly the events it would otherwise hide', async () => {
      const all = metaOf(await search('')).total;
      const matching = metaOf(await search('Lisa')).total;
      const excluded = metaOf(await search('!Lisa')).total;
      // Complement over the whole tenant, tenantless-actor rows included.
      expect(matching + excluded).toBe(all);
      expect(excluded).toBeGreaterThan(0);
    });
  });

  test('?filter_created_at range narrows results to the given window', async () => {
    currentUser = asUser(adminId, 'Admin');
    // Use a window anchored near now that covers the seeded rows (which were just inserted).
    const dateFrom = new Date(Date.now() - 60 * 1000).toISOString();
    const dateTo = new Date(Date.now() + 60 * 1000).toISOString();
    const range = `${encodeURIComponent(dateFrom)},${encodeURIComponent(dateTo)}`;
    const res = await auditReq<AuditRow[]>('GET', `/api/audit?filter_created_at=${range}`);
    expect(res.status).toBe(200);
    const rows = dataOf(res);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const t = new Date(row.created_at).getTime();
      expect(t).toBeGreaterThanOrEqual(new Date(dateFrom).getTime());
      expect(t).toBeLessThanOrEqual(new Date(dateTo).getTime());
    }
  });

  test('combining entity_type + event_type narrows to the intersection', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<AuditRow[]>('GET', '/api/audit?filter_entity_type=appointments&filter_event_type=appointment_scheduled');
    expect(res.status).toBe(200);
    const rows = dataOf(res);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.entity_type).toBe('appointments');
      expect(row.event_type).toBe('appointment_scheduled');
    }
  });

  test('filter that matches nothing returns empty data with total=0', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<AuditRow[]>('GET', '/api/audit?filter_event_type=event_that_does_not_exist_xyz');
    expect(res.status).toBe(200);
    expect(dataOf(res)).toHaveLength(0);
    expect(metaOf(res).total).toBe(0);
  });

  test('?outcome=denied returns only denied events, and meta.total matches the filtered set', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<AuditRow[]>('GET', '/api/audit?filter_outcome=denied');
    expect(res.status).toBe(200);
    const rows = dataOf(res);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.outcome).toBe('denied');
    // total is the server-side filtered count, not the unfiltered page count.
    expect(metaOf(res).total).toBe(rows.length);
  });

  test('?outcome=success excludes the denied event', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<AuditRow[]>('GET', '/api/audit?filter_outcome=success');
    expect(res.status).toBe(200);
    const rows = dataOf(res);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.outcome).toBe('success');
  });

  test('unknown outcome value → 422 (validated against the SSOT enum)', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<AuditRow[]>('GET', '/api/audit?filter_outcome=bogus');
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe('invalid_request');
  });
});

describe('GET /api/audit — negation honors the shared grammar instead of inverting it', () => {
  beforeAll(async () => {
    // A system-shaped event with no entity_type, to prove `!x` keeps NULL rows.
    await pool.query(
      `INSERT INTO audit_events
         (business_id, actor_user_id, event_type, entity_type, entity_id, outcome, details)
       VALUES ($1, $2, 'null_entity_probe', NULL, NULL, 'success', '{}')`,
      [bizId, adminId],
    );
  });

  test('filter_outcome=!success returns non-success events, not the inverse (the denied one)', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<AuditRow[]>('GET', '/api/audit?filter_outcome=!success&limit=500');
    expect(res.status).toBe(200);
    const rows = dataOf(res);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.outcome).not.toBe('success');
    expect(rows.some((r) => r.outcome === 'denied')).toBe(true);
  });

  test('a negated filter on a nullable column keeps its NULL rows (IS DISTINCT FROM)', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<AuditRow[]>('GET', '/api/audit?filter_entity_type=!appointments&limit=500');
    expect(res.status).toBe(200);
    const rows = dataOf(res);
    for (const row of rows) expect(row.entity_type).not.toBe('appointments');
    // `<> 'appointments'` would have dropped this NULL-entity_type row; IS DISTINCT FROM keeps it.
    expect(rows.some((r) => r.event_type === 'null_entity_probe')).toBe(true);
    expect(rows.some((r) => r.entity_type === 'ledger_entries')).toBe(true);
  });

  test('a set / repeated value is rejected, not silently narrowed to the first', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<AuditRow[]>('GET', '/api/audit?filter_outcome=success&filter_outcome=denied');
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe('invalid_request');
  });

  test('negation on the date range is rejected rather than silently ignored', async () => {
    currentUser = asUser(adminId, 'Admin');
    const iso = new Date(Date.now() - 60 * 1000).toISOString();
    const res = await auditReq<AuditRow[]>('GET', `/api/audit?filter_created_at=!${encodeURIComponent(iso)}`);
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe('invalid_request');
  });
});

describe('GET /api/audit — pagination', () => {
  test('limit and page params are honoured', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<AuditRow[]>('GET', '/api/audit?limit=2&page=1');
    expect(res.status).toBe(200);
    expect(dataOf(res).length).toBeLessThanOrEqual(2);
    expect(metaOf(res).page).toBe(1);
    expect(metaOf(res).limit).toBe(2);
  });

  test('limit is capped at 500', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<AuditRow[]>('GET', '/api/audit?limit=9999');
    expect(res.status).toBe(200);
    expect(metaOf(res).limit).toBe(500);
  });

  test('an out-of-range page remains empty but preserves the filtered total', async () => {
    currentUser = asUser(adminId, 'Admin');
    const first = await auditReq<AuditRow[]>('GET', '/api/audit?limit=1&page=1');
    const empty = await auditReq<AuditRow[]>('GET', '/api/audit?limit=1&page=500');
    expect(empty.status).toBe(200);
    expect(dataOf(empty)).toEqual([]);
    expect(metaOf(empty).total).toBe(metaOf(first).total);
  });
});

describe('GET /api/business/settings — any authenticated role, session-scoped', () => {
  test('a non-admin (Client) can read the cutoff for their own business', async () => {
    currentUser = asUser(clientId, 'Client');
    const res = await auditReq<BusinessSettingsRow>('GET', '/api/business/settings');
    expect(res.status).toBe(200);
    expect(dataOf(res)).toHaveProperty('cancellation_cutoff_hours');
    // Never exposes other business columns.
    expect(dataOf(res)).not.toHaveProperty('name');
  });

  test('returns the caller\'s own business cutoff (from session, not a request param)', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await auditReq<BusinessSettingsRow>('GET', '/api/business/settings');
    expect(res.status).toBe(200);
    expect(Number(dataOf(res).id)).toBe(bizId);
    expect(dataOf(res).cancellation_cutoff_hours).toBe(24);
  });
});

describe('GET /api/businesses/:id/settings — admin-only read', () => {
  test('non-admin → 403', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await auditReq<BusinessSettingsRow>('GET', `/api/businesses/${bizId}/settings`);
    expect(res.status).toBe(403);
  });

  test('admin reads current cutoff', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<BusinessSettingsRow>('GET', `/api/businesses/${bizId}/settings`);
    expect(res.status).toBe(200);
    expect(dataOf(res)).toHaveProperty('id');
    expect(dataOf(res)).toHaveProperty('cancellation_cutoff_hours');
    expect(dataOf(res)).not.toHaveProperty('name');
  });

  test('cross-tenant :id → 404 (hides existence)', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<BusinessSettingsRow>('GET', `/api/businesses/${biz2Id}/settings`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/businesses/:id/settings — admin-only cutoff', () => {
  test('non-admin → 403', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await auditReq<BusinessSettingsRow>('PATCH', `/api/businesses/${bizId}/settings`, {
      cancellation_cutoff_hours: 12,
    });
    expect(res.status).toBe(403);
  });

  test('admin updates cancellation_cutoff_hours and value persists', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<BusinessSettingsRow>('PATCH', `/api/businesses/${bizId}/settings`, {
      cancellation_cutoff_hours: 48,
    });
    expect(res.status).toBe(200);
    expect(Number(dataOf(res).cancellation_cutoff_hours)).toBe(48);

    const dbCheck = await pool.query<{ cancellation_cutoff_hours: number }>(
      `SELECT cancellation_cutoff_hours FROM businesses WHERE id = $1`,
      [bizId],
    );
    expect(dbCheck.rows[0].cancellation_cutoff_hours).toBe(48);

    await pool.query(`UPDATE businesses SET cancellation_cutoff_hours = 24 WHERE id = $1`, [bizId]);
  });

  test('negative value → 422 (validation + DB CHECK backstop)', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<BusinessSettingsRow>('PATCH', `/api/businesses/${bizId}/settings`, {
      cancellation_cutoff_hours: -1,
    });
    expect(res.status).toBe(422);
  });

  test('missing cancellation_cutoff_hours → 422', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<BusinessSettingsRow>('PATCH', `/api/businesses/${bizId}/settings`, {});
    expect(res.status).toBe(422);
  });

  test('non-integer value → 422', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<BusinessSettingsRow>('PATCH', `/api/businesses/${bizId}/settings`, {
      cancellation_cutoff_hours: 1.5,
    });
    expect(res.status).toBe(422);
  });

  test('cross-tenant :id → 404 (hides existence)', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<BusinessSettingsRow>('PATCH', `/api/businesses/${biz2Id}/settings`, {
      cancellation_cutoff_hours: 12,
    });
    // The endpoint always scopes to user.business_id; the :id param is ignored.
    // When biz2Id !== user.business_id the UPDATE returns zero rows → 404.
    expect(res.status).toBe(404);
  });

  test('endpoint does not expose other businesses columns', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<BusinessSettingsRow>('PATCH', `/api/businesses/${bizId}/settings`, {
      cancellation_cutoff_hours: 24,
      name: 'INJECTED',
    });
    expect(res.status).toBe(200);
    // Only id and cancellation_cutoff_hours in the RETURNING clause.
    expect(dataOf(res)).not.toHaveProperty('name');
    expect(dataOf(res)).toHaveProperty('id');
    expect(dataOf(res)).toHaveProperty('cancellation_cutoff_hours');

    const dbCheck = await pool.query<{ name: string }>(
      `SELECT name FROM businesses WHERE id = $1`,
      [bizId],
    );
    expect(dbCheck.rows[0].name).toBe('Audit Biz');
  });

  test('admin sets the booking window and it persists', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<BusinessSettingsRow>('PATCH', `/api/businesses/${bizId}/settings`, {
      cancellation_cutoff_hours: 24,
      min_booking_days: 1,
      max_booking_days: 30,
    });
    expect(res.status).toBe(200);
    expect(dataOf(res).min_booking_days).toBe(1);
    expect(dataOf(res).max_booking_days).toBe(30);

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
    await auditReq<BusinessSettingsRow>('PATCH', `/api/businesses/${bizId}/settings`, {
      cancellation_cutoff_hours: 24, min_booking_days: 2, max_booking_days: 10,
    });
    const res = await auditReq<BusinessSettingsRow>('PATCH', `/api/businesses/${bizId}/settings`, {
      cancellation_cutoff_hours: 24, max_booking_days: null,
    });
    expect(res.status).toBe(200);
    expect(dataOf(res).max_booking_days).toBeNull();
    expect(dataOf(res).min_booking_days).toBe(2); // untouched by this PATCH
    await pool.query(
      `UPDATE businesses SET min_booking_days = 0, max_booking_days = NULL WHERE id = $1`,
      [bizId],
    );
  });

  test('max_booking_days < min_booking_days → 422', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<BusinessSettingsRow>('PATCH', `/api/businesses/${bizId}/settings`, {
      cancellation_cutoff_hours: 24, min_booking_days: 10, max_booking_days: 5,
    });
    expect(res.status).toBe(422);
    // The specific field reason travels as a localizable key, not English prose.
    expect(errorOf(res).fieldDetails?.max_booking_days).toEqual({ key: 'maxBookingBelowMin' });
  });

  test('negative min_booking_days → 422', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<BusinessSettingsRow>('PATCH', `/api/businesses/${bizId}/settings`, {
      cancellation_cutoff_hours: 24, min_booking_days: -1,
    });
    expect(res.status).toBe(422);
    expect(errorOf(res).fieldDetails?.min_booking_days).toEqual({ key: 'nonNegativeInteger' });
  });

  test('cutoff-only PATCH leaves the window unchanged', async () => {
    currentUser = asUser(adminId, 'Admin');
    await pool.query(
      `UPDATE businesses SET min_booking_days = 3, max_booking_days = 40 WHERE id = $1`,
      [bizId],
    );
    const res = await auditReq<BusinessSettingsRow>('PATCH', `/api/businesses/${bizId}/settings`, {
      cancellation_cutoff_hours: 12,
    });
    expect(res.status).toBe(200);
    expect(dataOf(res).min_booking_days).toBe(3);
    expect(dataOf(res).max_booking_days).toBe(40);
    await pool.query(
      `UPDATE businesses SET cancellation_cutoff_hours = 24, min_booking_days = 0, max_booking_days = NULL WHERE id = $1`,
      [bizId],
    );
  });
});

describe('GET /api/audit — malformed date filters (WR-04)', () => {
  test('malformed created_at lower bound returns 422 invalid_request', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<AuditRow[]>('GET', '/api/audit?filter_created_at=notadate');
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe('invalid_request');
  });

  test('malformed created_at upper bound returns 422 invalid_request', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<AuditRow[]>('GET', `/api/audit?filter_created_at=,${encodeURIComponent('01/01/2024')}`);
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe('invalid_request');
  });

  test('valid ISO timestamp created_at lower bound still returns 200', async () => {
    currentUser = asUser(adminId, 'Admin');
    const iso = new Date(Date.now() - 60 * 1000).toISOString();
    const res = await auditReq<AuditRow[]>('GET', `/api/audit?filter_created_at=${encodeURIComponent(iso)},`);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/audit — a date-only filter means that day in the business timezone', () => {
  // The probe events sit on a day well in the past with their instants pinned explicitly, so the
  // outcome does not depend on what time of day the suite happens to run.
  const probeDay = new Date(Date.now() - 100 * 24 * 3600 * 1000)
    .toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });
  const dayBefore = addDaysISO(probeDay, -1);
  const dayAfter = addDaysISO(probeDay, 1);

  const probes: Array<{ eventType: string; day: string; time: string }> = [
    { eventType: 'tz_probe_prev_day_end', day: dayBefore, time: '23:59:59' },
    { eventType: 'tz_probe_day_start', day: probeDay, time: '00:00:00' },
    { eventType: 'tz_probe_evening', day: probeDay, time: '21:18:02' },
    { eventType: 'tz_probe_day_end', day: probeDay, time: '23:59:59' },
    { eventType: 'tz_probe_next_day', day: dayAfter, time: '00:00:00' },
  ];

  beforeAll(async () => {
    for (const { eventType, day, time } of probes) {
      await pool.query(
        `INSERT INTO audit_events
           (business_id, actor_user_id, event_type, entity_type, outcome, details, created_at)
         VALUES ($1, $2, $3, 'appointments', 'success', '{}', (($4::date + $5::time) AT TIME ZONE $6))`,
        [bizId, adminId, eventType, day, time, BUSINESS_TZ],
      );
    }
  });

  async function probeDayEvents(): Promise<{ types: string[]; total: number }> {
    currentUser = asUser(adminId, 'Admin');
    const res = await auditReq<AuditRow[]>(
      'GET',
      `/api/audit?filter_created_at=${probeDay},${probeDay}&limit=500`,
    );
    expect(res.status).toBe(200);
    return { types: dataOf(res).map((r) => r.event_type), total: metaOf(res).total };
  }

  test('an event late in the business day is inside a filter naming that day', async () => {
    const { types } = await probeDayEvents();
    expect(types).toContain('tz_probe_evening');
  });

  test('date_to includes the last moment of the day and excludes the next day', async () => {
    const { types } = await probeDayEvents();
    expect(types).toContain('tz_probe_day_end');
    expect(types).not.toContain('tz_probe_next_day');
  });

  test('date_from starts at the first moment of the day and excludes the day before', async () => {
    const { types } = await probeDayEvents();
    expect(types).toContain('tz_probe_day_start');
    expect(types).not.toContain('tz_probe_prev_day_end');
  });

  test('meta.total counts exactly that business day', async () => {
    const { total } = await probeDayEvents();
    expect(total).toBe(3);
  });
});
