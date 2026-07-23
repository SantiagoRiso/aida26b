import { createApp } from '../src/app';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import {
  getTableKeys,
  getCrudPolicy,
  getForeignKeyColumns,
  isProtected,
  tableOf,
} from '../../shared/src/utils/utils';
import type { TableKey } from '../../shared/src/ssot/derived';
import type { AuthUser } from '../src/auth';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Server } from 'node:http';

// Every FK a generic write carries must resolve inside the caller's tenant. The cases below are
// derived from the SSOT, so a newly declared FK to a business-scoped table is covered here the day
// it is declared — an undeclared fixture fails the suite instead of silently skipping the column.

type Payload = Record<string, string | number | boolean | null>;

let API_BASE = '';
let server: Server;
let pool: Pool;

// Two tenants: the caller's, and the one whose rows must stay unreachable.
let ownBizId: string;
let foreignBizId: string;

const ownRow: Partial<Record<TableKey, string>> = {};
const foreignRow: Partial<Record<TableKey, string>> = {};

let ownClientId: string;
let ownProId: string;

const admin = (): AuthUser => ({
  id: 0,
  username: 'xt-admin',
  email: null,
  role: 'Admin',
  business_id: Number(ownBizId),
  is_active: true,
  must_change_password: false,
});

async function api(path: string, body?: Payload, method = 'POST') {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => null)) as
    | { success: true }
    | { success: false; error: { code: string } }
    | null;
  return { status: response.status, body: parsed };
}

// A tenant's fixture set: one row of every referenced kind, so either business can stand in as the
// source of a reference.
async function seedBusiness(name: string): Promise<{ bizId: string; clientId: string; proId: string }> {
  const biz = await pool.query<{ id: string }>(`INSERT INTO businesses (name) VALUES ($1) RETURNING id`, [name]);
  const bizId = biz.rows[0].id;

  const pro = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id)
     VALUES ($1, $2, 'Pro', 'h', 's', 'Professional', $3) RETURNING id`,
    [`${name}_pro`, `${name}_pro@test.local`, bizId],
  );
  const client = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id)
     VALUES ($1, $2, 'Cli', 'h', 's', 'Client', $3) RETURNING id`,
    [`${name}_cli`, `${name}_cli@test.local`, bizId],
  );
  const service = await pool.query<{ id: string }>(
    `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
     VALUES ($1, 'Svc', 30, '100.00') RETURNING id`,
    [bizId],
  );
  const resource = await pool.query<{ id: string }>(
    `INSERT INTO resources (business_id, name) VALUES ($1, 'Sala') RETURNING id`,
    [bizId],
  );
  const block = await pool.query<{ id: string }>(
    `INSERT INTO schedule_blocks (professional_user_id, weekday, start_time, end_time)
     VALUES ($1, 'sun', '09:00', '12:00') RETURNING id`,
    [pro.rows[0].id],
  );

  const rows = name === 'own' ? ownRow : foreignRow;
  rows.clients = client.rows[0].id;
  rows.professionals = pro.rows[0].id;
  rows.services = service.rows[0].id;
  rows.resources = resource.rows[0].id;
  rows.schedule_blocks = block.rows[0].id;

  return { bizId, clientId: client.rows[0].id, proId: pro.rows[0].id };
}

// A valid, in-tenant creation payload per writable table that carries a tenant-scoped FK. Anything
// unique (weekday, date) is varied by the caller so the positive control can't collide.
function basePayload(table: TableKey, variant: number): Payload | null {
  switch (table) {
    case 'client_professional_services':
      return {
        client_user_id: ownClientId,
        professional_user_id: ownProId,
        service_id: ownRow.services!,
        price_ars: '10.00',
      };
    case 'professional_services':
      return {
        professional_user_id: ownProId,
        service_id: ownRow.services!,
        min_booking_days: null,
        max_booking_days: null,
      };
    case 'schedule_block_services':
      return {
        professional_user_id: ownProId,
        schedule_block_id: ownRow.schedule_blocks!,
        service_id: ownRow.services!,
        duration_minutes: null,
        price_ars: null,
      };
    case 'schedule_blocks':
      return {
        professional_user_id: ownProId,
        resource_id: null,
        weekday: 'mon',
        start_time: `${String(8 + variant).padStart(2, '0')}:00`,
        end_time: `${String(8 + variant).padStart(2, '0')}:45`,
      };
    case 'schedule_exceptions':
      return {
        professional_user_id: ownProId,
        resource_id: null,
        exception_date: `2027-03-${String(1 + variant).padStart(2, '0')}`,
        is_unavailable: true,
        start_time: null,
        end_time: null,
        granularity_minutes: null,
        reason: null,
      };
    default:
      return null;
  }
}

// The cases the SSOT declares: a generically creatable table, an FK column of its own, and a
// referenced table that derives a business of its own (directly or through a join).
type Case = { table: TableKey; column: string; referencedTable: TableKey };

function declaredCases(): Case[] {
  const cases: Case[] = [];
  for (const table of getTableKeys()) {
    if (isProtected(table) || !getCrudPolicy(table)?.create) continue;
    for (const { column, referencedTable } of getForeignKeyColumns(table)) {
      const meta = tableOf(referencedTable);
      if (meta.businessScoped !== true && meta.businessJoin == null) continue;
      cases.push({ table, column, referencedTable });
    }
  }
  return cases;
}

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const own = await seedBusiness('own');
  ownBizId = own.bizId;
  ownClientId = own.clientId;
  ownProId = own.proId;
  foreignBizId = (await seedBusiness('foreign')).bizId;

  const app = createApp(pool, { defaultUser: admin() });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  API_BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

afterAll(async () => {
  await pool.end();
  server.close();
});

describe('cross-tenant foreign keys on the generic write path', () => {
  test('the SSOT declares cases to check', () => {
    expect(foreignBizId).toBeTruthy();
    expect(declaredCases().length).toBeGreaterThan(0);
  });

  test('every declared FK to a tenant-scoped table is rejected as not_found', async () => {
    let variant = 0;
    const byTable = new Map<TableKey, Case[]>();
    for (const c of declaredCases()) {
      byTable.set(c.table, [...(byTable.get(c.table) ?? []), c]);
    }

    for (const [table, cases] of byTable) {
      const payload = basePayload(table, variant++);
      // A new writable table with a tenant-scoped FK must be given a payload here, not skipped.
      expect(payload, `${table} has no base payload`).not.toBeNull();

      // The same payload must succeed in-tenant, so a 404 below is the tenant check and not a
      // malformed body.
      const control = await api(`/${table}`, payload!);
      expect(control.status, `in-tenant control for ${table}`).toBe(201);

      for (const { column, referencedTable } of cases) {
        const foreignId = foreignRow[referencedTable];
        expect(foreignId, `no foreign fixture for ${referencedTable}`).toBeTruthy();

        const crossTenant = await api(`/${table}`, { ...payload!, [column]: foreignId! });
        expect(crossTenant.status, `${table}.${column} pointing at another tenant`).toBe(404);
        expect(crossTenant.body).toMatchObject({ success: false, error: { code: 'not_found' } });
      }
    }
  });

  test('an unknown id is answered exactly like a cross-tenant one', async () => {
    const res = await api('/professional_services', {
      professional_user_id: ownProId,
      service_id: '999999',
      min_booking_days: null,
      max_booking_days: null,
    });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: { code: 'not_found' } });
  });

  test('a cross-tenant reference is rejected on update too', async () => {
    const created = await api('/client_professional_services', {
      client_user_id: ownClientId,
      professional_user_id: ownProId,
      service_id: ownRow.services!,
      price_ars: '20.00',
    });
    expect([201, 409]).toContain(created.status);

    const row = await pool.query<{ id: string }>(
      `SELECT id FROM client_professional_services WHERE client_user_id = $1 ORDER BY id LIMIT 1`,
      [ownClientId],
    );
    const res = await api(
      `/client_professional_services/${row.rows[0].id}`,
      {
        client_user_id: ownClientId,
        professional_user_id: ownProId,
        service_id: foreignRow.services!,
        price_ars: '30.00',
      },
      'PUT',
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: { code: 'not_found' } });

    const stored = await pool.query<{ service_id: string }>(
      `SELECT service_id FROM client_professional_services WHERE id = $1`,
      [row.rows[0].id],
    );
    expect(stored.rows[0].service_id).not.toBe(foreignRow.services);
  });

  test('nothing from the foreign tenant was written', async () => {
    for (const table of ['client_professional_services', 'professional_services'] as const) {
      const leaked = await pool.query(
        `SELECT 1 FROM ${table} WHERE service_id = $1`,
        [foreignRow.services!],
      );
      expect(leaked.rows.length, `${table} references a foreign service`).toBe(0);
    }
    const leakedBlockServices = await pool.query(
      `SELECT 1 FROM schedule_block_services WHERE service_id = $1 OR schedule_block_id = $2`,
      [foreignRow.services!, foreignRow.schedule_blocks!],
    );
    expect(leakedBlockServices.rows.length).toBe(0);
  });
});
