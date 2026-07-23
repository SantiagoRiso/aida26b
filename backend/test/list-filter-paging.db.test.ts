import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { mountGenericRoutes } from '../src/app';
import { buildListStatement } from '../src/db/generic';
import { getTableKeys, tableOf } from '../../shared/src/utils/utils';
import type { ListRequestSpec } from '../../shared/src/ssot/list-protocol';
import { encodeFilterSet, LIST_MAX_FILTER_SET } from '../../shared/src/ssot/list-protocol';
import type { AuthUser } from '../src/auth';

// The list engine against a live database: what the descriptor promises to project, what a filter
// actually narrows, and whether two pages of the same list agree on which rows exist.
let pool: Pool;
let server: http.Server;
let baseUrl: string;
let currentUser: AuthUser;

const injectUser: express.RequestHandler = (req, _res, next) => {
  (req as express.Request & { user?: AuthUser }).user = currentUser;
  next();
};

let bizId: string;
let adminId: number;
let clientId: number;

const ACTIVE_CLIENTS = 5;
const INACTIVE_CLIENTS = 3;
const PROFESSIONALS = 4;

async function seedUser(username: string, role: string, isActive = true, displayName?: string): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, is_active, must_change_password)
     VALUES ($1, $2, $3, 'h', 's', $4, $5, $6, false) RETURNING id`,
    [username, `${username}@test.local`, displayName ?? username, role, bizId, isActive],
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

// eslint-disable-next-line no-restricted-syntax -- boundary: decoded JSON rows from the list endpoint are untrusted until a field is read
type Page = { data: Array<Record<string, unknown>>; meta?: { total: number } };

async function list(table: string, params: Record<string, string> = {}): Promise<Page> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${baseUrl}/api/${table}${qs ? `?${qs}` : ''}`);
  return (await res.json()) as Page;
}

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const biz = await pool.query<{ id: string }>(
    `INSERT INTO businesses (name) VALUES ('List Engine Biz') RETURNING id`,
  );
  bizId = biz.rows[0].id;

  adminId = await seedUser('lf_admin', 'Admin');

  for (let i = 0; i < ACTIVE_CLIENTS; i++) {
    const id = await seedUser(`lf_client_a${i}`, 'Client', true, `Simpson ${i}`);
    if (i === 0) clientId = id;
  }
  for (let i = 0; i < INACTIVE_CLIENTS; i++) {
    await seedUser(`lf_client_i${i}`, 'Client', false, `Bouvier ${i}`);
  }
  for (let i = 0; i < PROFESSIONALS; i++) {
    await seedUser(`lf_pro${i}`, 'Professional', true, `Dr Nick ${i}`);
  }

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

describe('list projection', () => {
  test('a Client reading professionals gets the declared columns and nothing else', async () => {
    currentUser = asUser(clientId, 'Client');
    const page = await list('professionals');

    expect(page.data).toHaveLength(PROFESSIONALS);
    for (const row of page.data) {
      expect(Object.keys(row).sort()).toEqual(Object.keys(tableOf('professionals').columns).sort());
    }
  });

  test('a single professional read by id projects the same columns as the list', async () => {
    currentUser = asUser(clientId, 'Client');
    const page = await list('professionals');
    const id = page.data[0].id as string;

    const res = await fetch(`${baseUrl}/api/professionals?id=${id}`);
    // eslint-disable-next-line no-restricted-syntax -- boundary: the decoded JSON row is untrusted until a field is read
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(Object.keys(body.data).sort()).toEqual(Object.keys(page.data[0]).sort());
  });
});

describe('boolean filters narrow the list', () => {
  test('filtering on false returns only the inactive accounts', async () => {
    currentUser = asUser(adminId, 'Admin');

    const all = await list('users');
    const inactive = await list('users', { filter_is_active: 'false' });
    const active = await list('users', { filter_is_active: 'true' });

    expect(all.meta?.total).toBe(1 + ACTIVE_CLIENTS + INACTIVE_CLIENTS + PROFESSIONALS);
    expect(inactive.meta?.total).toBe(INACTIVE_CLIENTS);
    expect(active.meta?.total).toBe(all.meta!.total - INACTIVE_CLIENTS);
    expect(inactive.data.every((row) => row.is_active === false)).toBe(true);
  });

  test('excluding true is the same set as filtering on false', async () => {
    currentUser = asUser(adminId, 'Admin');
    const excluded = await list('users', { filter_is_active: '!true' });

    expect(excluded.meta?.total).toBe(INACTIVE_CLIENTS);
  });

  test('a value that is not a boolean returns nothing, not everything', async () => {
    currentUser = asUser(adminId, 'Admin');
    const junk = await list('users', { filter_is_active: 'sí' });

    expect(junk.data).toEqual([]);
    expect(junk.meta?.total).toBe(0);
  });
});

describe('text filters treat LIKE metacharacters as literals', () => {
  test('a wildcard matches only a name that actually contains it', async () => {
    currentUser = asUser(adminId, 'Admin');

    const named = await list('clients', { filter_display_name: 'Simpson' });
    const percent = await list('clients', { filter_display_name: '%' });
    const underscore = await list('clients', { filter_display_name: '_' });

    expect(named.meta?.total).toBe(ACTIVE_CLIENTS);
    expect(percent.meta?.total).toBe(0);
    expect(underscore.meta?.total).toBe(0);
  });
});

// Resolving labels for ids scattered past the first page is one request per set, not one per id.
describe('id set filters', () => {
  test('a set returns exactly the rows it names', async () => {
    currentUser = asUser(adminId, 'Admin');

    const all = await list('users', { limit: '500' });
    const wanted = all.data.slice(0, 3).map((row) => row.id as string);

    const page = await list('users', { filter_id: encodeFilterSet(wanted) });

    expect(page.meta?.total).toBe(wanted.length);
    expect((page.data.map((row) => row.id as string)).sort()).toEqual([...wanted].sort());
  });

  test('a single id still reads as an exact match, not a prefix', async () => {
    currentUser = asUser(adminId, 'Admin');

    const page = await list('users', { filter_id: String(adminId) });

    expect(page.meta?.total).toBe(1);
    expect(page.data[0].id).toBe(String(adminId));
  });

  test('excluding a set drops every member and keeps the rest', async () => {
    currentUser = asUser(adminId, 'Admin');

    const total = (await list('users')).meta!.total;
    const excluded = await list('users', { filter_id: `!${encodeFilterSet([String(adminId), String(clientId)])}` });

    expect(excluded.meta?.total).toBe(total - 2);
    expect(excluded.data.some((row) => row.id === String(adminId))).toBe(false);
  });

  test('a set cannot reach a row the viewer is not scoped to', async () => {
    const other = await pool.query<{ id: string }>(
      `INSERT INTO businesses (name) VALUES ('Other Biz') RETURNING id`,
    );
    const outsider = await pool.query<{ id: string }>(
      `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, is_active, must_change_password)
       VALUES ('lf_outsider', 'lf_outsider@test.local', 'Outsider', 'h', 's', 'Client', $1, true, false) RETURNING id`,
      [other.rows[0].id],
    );

    currentUser = asUser(adminId, 'Admin');
    const page = await list('clients', {
      filter_id: encodeFilterSet([String(clientId), outsider.rows[0].id]),
      include_unrelated: '1',
    });

    expect(page.data.map((row) => row.id)).toEqual([String(clientId)]);
  });

  test('a set beyond the cap returns nothing rather than a truncated answer', async () => {
    currentUser = asUser(adminId, 'Admin');
    const tooMany = Array.from({ length: LIST_MAX_FILTER_SET + 1 }, (_, n) => String(n + 1));

    const page = await list('users', { filter_id: encodeFilterSet(tooMany) });

    expect(page.data).toEqual([]);
    expect(page.meta?.total).toBe(0);
  });
});

describe('paging a tied sort', () => {
  test('sorting on a column full of ties still visits every row exactly once', async () => {
    currentUser = asUser(adminId, 'Admin');

    const total = (await list('users')).meta!.total;
    const limit = 3;
    const seen: string[] = [];

    for (let page = 1; (page - 1) * limit < total; page++) {
      const chunk = await list('users', { sort: 'role', limit: String(limit), page: String(page) });
      seen.push(...chunk.data.map((row) => row.id as string));
    }

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });
});

// Every table carrying a filterable `date` column is workflow-owned, so no generic route reaches
// one. The compiler is still what builds their statements, so exercise it against the live schema.
describe('date filters', () => {
  function dateFilter(value: string): ListRequestSpec {
    return {
      filters: [{ field: 'starts_at', values: [{ negated: false, value }] }],
      dir: 'asc',
      page: 1,
      limit: 50,
      includeUnrelated: false,
    };
  }

  async function countAppointments(value: string): Promise<number> {
    const { dataQuery, dataValues } = buildListStatement('appointments', dateFilter(value), {
      sqlTable: 'appointments',
      businessWhere: '',
      businessParams: [],
    });
    const res = await pool.query<{ __total_count: string }>(dataQuery, dataValues);
    return res.rows.length === 0 ? 0 : Number(res.rows[0].__total_count);
  }

  test('a range narrows to the days it names, and junk narrows to nothing', async () => {
    const svc = await pool.query<{ id: string }>(
      `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
       VALUES ($1, 'Consulta', 30, '1500.00') RETURNING id`,
      [bizId],
    );
    const pro = await seedUser('lf_pro_dates', 'Professional');

    for (const startsAt of ['2026-09-10 12:00:00-03', '2026-10-15 12:00:00-03']) {
      await pool.query(
        `INSERT INTO appointments
           (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
         VALUES ($1, $2, $3, $4, 30, 'scheduled', '1500.00', false)`,
        [clientId, pro, svc.rows[0].id, startsAt],
      );
    }

    expect(await countAppointments('2026-09-01,2026-09-30')).toBe(1);
    expect(await countAppointments('2026-10-15')).toBe(1);
    expect(await countAppointments('2026-09-01,2026-10-31')).toBe(2);
    expect(await countAppointments('someday')).toBe(0);
  });
});

// A declared column the read source doesn't have would have gone unnoticed behind `SELECT *`.
describe('the declared projection is valid SQL for every table', () => {
  // App tables live under `public` and `auth` alike (auth.sessions has no sqlTable override), so
  // the schema of an unqualified descriptor key comes from the catalog, not an assumption.
  async function readSourceOf(table: string): Promise<string> {
    const meta = tableOf(table as never);
    const raw = meta.sqlReadTable ?? meta.sqlTable ?? table;
    if (raw.includes('.')) return raw;

    const found = await pool.query<{ table_schema: string }>(
      `SELECT table_schema FROM information_schema.tables
        WHERE table_name = $1 AND table_schema IN ('public', 'auth')`,
      [raw],
    );
    expect(found.rows).toHaveLength(1);
    return `${found.rows[0].table_schema}.${raw}`;
  }

  test('each compiled list statement runs against the live schema', async () => {
    for (const table of getTableKeys()) {
      const { dataQuery, dataValues } = buildListStatement(
        table,
        { filters: [], dir: 'asc', page: 1, limit: 1, includeUnrelated: false },
        {
          sqlTable: await readSourceOf(table),
          businessWhere: '',
          businessParams: [],
        },
      );
      await expect(pool.query(dataQuery, dataValues)).resolves.toBeDefined();
    }
  });
});
