import { createApp } from '../src/app';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { tableOf, getTableKeys, getSoftDeletePolicy } from '../../shared/src/utils/utils';
import type { AuthUser } from '../src/auth';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Server } from 'node:http';

// The soft-delete path stamps deleted_by_user_id, so the acting admin must be a real row.
const superAdmin: AuthUser = {
  id: 0,
  username: 'projection_admin',
  email: null,
  role: 'Admin',
  business_id: null,
  is_active: true,
  must_change_password: false,
};

let API_BASE = '';
let server: Server;
let testsPool: Pool;
let clientUserId: string;
let professionalUserId: string;

// Columns that exist on the write table but no clients/professionals descriptor declares —
// credentials, tenancy, activation, bookkeeping. Read from the catalog so a column added to
// auth.users later is covered without touching this test.
async function undeclaredWriteTableColumns(table: 'clients' | 'professionals'): Promise<string[]> {
  const declared = new Set(Object.keys(tableOf(table).columns));
  const physical = await testsPool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'auth' AND table_name = 'users'`,
  );
  return physical.rows.map((row) => row.column_name).filter((column) => !declared.has(column));
}

async function api(path: string, init?: RequestInit) {
  const response = await fetch(`${API_BASE}${path}`, init);
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

beforeAll(async () => {
  await resetTestDb();
  testsPool = makeTestPool();
  await runMigrations(testsPool, DEFAULT_MIGRATIONS_DIR);

  const business = await testsPool.query<{ id: string }>(
    `INSERT INTO businesses (name) VALUES ('Projection Test Business') RETURNING id`,
  );
  const businessId = business.rows[0].id;

  const admin = await testsPool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id)
     VALUES ('projection_admin', 'admin@projection.test', 'Projection Admin', 'secret-hash', 'secret-salt', 'Admin', NULL)
     RETURNING id`,
  );
  superAdmin.id = Number(admin.rows[0].id);

  const client = await testsPool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id)
     VALUES ('proj_cli', 'cli@projection.test', 'Projection Client', 'secret-hash', 'secret-salt', 'Client', $1)
     RETURNING id`,
    [businessId],
  );
  clientUserId = client.rows[0].id;

  const professional = await testsPool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id)
     VALUES ('proj_pro', 'pro@projection.test', 'Projection Pro', 'secret-hash', 'secret-salt', 'Professional', $1)
     RETURNING id`,
    [businessId],
  );
  professionalUserId = professional.rows[0].id;

  const app = createApp(testsPool, { defaultUser: superAdmin });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  API_BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

afterAll(async () => {
  await testsPool.end();
  server.close();
});

// Writes hit auth.users directly while reads go through the secret-free view, so the write
// response is the one place credentials can escape.
describe('generic write responses never leak columns the read path hides', () => {
  test('PUT clients returns exactly the declared columns', async () => {
    const res = await api(`/clients/${clientUserId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display_name: 'Projection Client Renamed',
        phone: '1144440000',
        dni: '30440000',
        notes: null,
      }),
    });

    expect(res.status).toBe(202);
    expect(Object.keys(res.body.data).sort()).toEqual(
      Object.keys(tableOf('clients').columns).sort(),
    );
    for (const column of await undeclaredWriteTableColumns('clients')) {
      expect(res.body.data, column).not.toHaveProperty(column);
    }
    expect(res.body.data.display_name).toBe('Projection Client Renamed');
    expect(res.body.data.dni).toBe('30440000');
  });

  test('PUT professionals returns exactly the declared columns', async () => {
    const res = await api(`/professionals/${professionalUserId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'Projection Pro Renamed', bio: 'Bio' }),
    });

    expect(res.status).toBe(202);
    expect(Object.keys(res.body.data).sort()).toEqual(
      Object.keys(tableOf('professionals').columns).sort(),
    );
    for (const column of await undeclaredWriteTableColumns('professionals')) {
      expect(res.body.data, column).not.toHaveProperty(column);
    }
  });

  test('DELETE clients soft-deletes and returns exactly the declared columns', async () => {
    const res = await api(`/clients/${clientUserId}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(
      Object.keys(tableOf('clients').columns).sort(),
    );
    for (const column of await undeclaredWriteTableColumns('clients')) {
      expect(res.body.data, column).not.toHaveProperty(column);
    }

    const stored = await testsPool.query<{ deleted_at: Date | null; is_active: boolean }>(
      `SELECT deleted_at, is_active FROM auth.users WHERE id = $1`,
      [clientUserId],
    );
    expect(stored.rows[0].deleted_at).not.toBeNull();
    // Archiving an account through the generic route also retires it, exactly as the admin
    // Usuarios screen does — guards across scheduling, grants and booking read is_active.
    expect(stored.rows[0].is_active).toBe(false);
  });
});

// activeColumn is a descriptor declaration, so nothing stops a table from naming a column its
// physical write table doesn't have; the failure would only surface as a 500 on a real delete.
describe('every declared soft-delete column exists on the table writes target', () => {
  for (const table of getTableKeys()) {
    const policy = getSoftDeletePolicy(table);
    if (!policy) continue;

    test(`${table}`, async () => {
      const physical = tableOf(table).sqlTable ?? table;
      const [schema, name] = physical.includes('.')
        ? physical.split('.')
        : ['public', physical];

      const columns = await testsPool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2`,
        [schema, name],
      );
      const present = new Set(columns.rows.map((row) => row.column_name));

      const declared = [policy.deletedAtColumn, policy.deletedByColumn, policy.activeColumn].filter(
        (column): column is string => column !== undefined,
      );
      for (const column of declared) {
        expect(present.has(column), `${physical}.${column}`).toBe(true);
      }
    });
  }
});
