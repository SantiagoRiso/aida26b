import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { mountGenericRoutes } from '../src/app';
import type { AuthUser } from '../src/auth';
import { INCLUDE_UNRELATED_PARAM, INCLUDE_UNRELATED_VALUE } from '../../shared/src/ssot/list-protocol';

// Relevance narrowing on the clients list: staff who are not Admin see the people they have
// already worked with. The narrowing is a scope on the statement, so the total the pager reads
// counts the same rows the page returns — the sparse-page defect this replaces came from
// narrowing the fetched page after the server had counted a wider set.
let pool: Pool;
let server: http.Server;
let baseUrl: string;
let currentUser: AuthUser;

const injectUser: express.RequestHandler = (req, _res, next) => {
  (req as express.Request & { user?: AuthUser }).user = currentUser;
  next();
};

let bizId: string;
let proId: number;
let otherProId: number;
let recepWithGrant: number;
let recepNoGrant: number;
let svcId: string;

// 6 clients: 3 seen by proId, 1 seen by otherProId, 2 never booked.
const relatedNames = ['cr_client_a', 'cr_client_b', 'cr_client_c'] as const;
const clientIds: Record<string, number> = {};

async function seedUser(username: string, role: string): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ($1, $2, $3, 'h', 's', $4, $5, false) RETURNING id`,
    [username, `${username}@test.local`, username, role, bizId],
  );
  return Number(r.rows[0].id);
}

let slot = 0;
async function seedAppointment(clientUserId: number, professionalUserId: number): Promise<void> {
  slot += 1;
  await pool.query(
    `INSERT INTO appointments
       (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
     VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval, 30, 'scheduled', '1500.00', false)`,
    [clientUserId, professionalUserId, svcId, String(slot * 2)],
  );
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

type ClientPage = { data: Array<{ id: string; display_name: string }>; meta?: { total: number } };

async function listClients(params: Record<string, string> = {}): Promise<ClientPage> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${baseUrl}/api/clients${qs ? `?${qs}` : ''}`);
  return (await res.json()) as ClientPage;
}

const namesOf = (page: ClientPage) => page.data.map((row) => row.display_name).sort();

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const biz = await pool.query<{ id: string }>(
    `INSERT INTO businesses (name) VALUES ('Relevance Biz') RETURNING id`,
  );
  bizId = biz.rows[0].id;

  proId = await seedUser('cr_pro', 'Professional');
  otherProId = await seedUser('cr_pro_other', 'Professional');
  recepWithGrant = await seedUser('cr_recep_yes', 'Receptionist');
  recepNoGrant = await seedUser('cr_recep_no', 'Receptionist');

  const svc = await pool.query<{ id: string }>(
    `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
     VALUES ($1, 'Consulta', 30, '1500.00') RETURNING id`,
    [bizId],
  );
  svcId = svc.rows[0].id;

  await pool.query(`INSERT INTO calendar_grants (professional_user_id, grantee_user_id) VALUES ($1, $2)`, [
    proId,
    recepWithGrant,
  ]);

  for (const name of [...relatedNames, 'cr_client_other', 'cr_client_new1', 'cr_client_new2']) {
    clientIds[name] = await seedUser(name, 'Client');
  }

  for (const name of relatedNames) {
    await seedAppointment(clientIds[name], proId);
  }
  await seedAppointment(clientIds['cr_client_other'], otherProId);

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

describe('clients list — prior-relationship narrowing', () => {
  test('a Professional gets only their own clients, and the total counts that same set', async () => {
    currentUser = asUser(proId, 'Professional');
    const page = await listClients();

    expect(namesOf(page)).toEqual([...relatedNames].sort());
    expect(page.meta?.total).toBe(relatedNames.length);
    expect(page.data.length).toBe(page.meta?.total);
  });

  test('waiving the narrowing widens the list and the total together', async () => {
    currentUser = asUser(proId, 'Professional');
    const page = await listClients({ [INCLUDE_UNRELATED_PARAM]: INCLUDE_UNRELATED_VALUE });

    expect(namesOf(page)).toEqual(Object.keys(clientIds).sort());
    expect(page.meta?.total).toBe(Object.keys(clientIds).length);
  });

  test('paging a narrowed list never promises a page the server will not fill', async () => {
    currentUser = asUser(proId, 'Professional');

    const first = await listClients({ limit: '2', page: '1' });
    const second = await listClients({ limit: '2', page: '2' });

    expect(first.data).toHaveLength(2);
    expect(second.data).toHaveLength(1);
    expect(first.meta?.total).toBe(3);
    expect(second.meta?.total).toBe(3);

    const seen = [...namesOf(first), ...namesOf(second)].sort();
    expect(seen).toEqual([...relatedNames].sort());
  });

  test('a search inside the narrowed set counts only the rows it can return', async () => {
    currentUser = asUser(proId, 'Professional');
    const page = await listClients({ filter_display_name: 'cr_client_new' });

    expect(page.data).toEqual([]);
    expect(page.meta?.total).toBe(0);
  });

  test('a Receptionist is narrowed to the clients of the calendars they are granted', async () => {
    currentUser = asUser(recepWithGrant, 'Receptionist');
    expect(namesOf(await listClients())).toEqual([...relatedNames].sort());

    currentUser = asUser(recepNoGrant, 'Receptionist');
    const none = await listClients();
    expect(none.data).toEqual([]);
    expect(none.meta?.total).toBe(0);
  });

  test('an Admin sees every client in the business, waiver or not', async () => {
    currentUser = asUser(900001, 'Admin');

    const plain = await listClients();
    expect(namesOf(plain)).toEqual(Object.keys(clientIds).sort());
    expect(plain.meta?.total).toBe(Object.keys(clientIds).length);

    const waived = await listClients({ [INCLUDE_UNRELATED_PARAM]: INCLUDE_UNRELATED_VALUE });
    expect(namesOf(waived)).toEqual(namesOf(plain));
  });

  test('relevance is not permission: an unrelated client stays readable by id', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await fetch(`${baseUrl}/api/clients?id=${clientIds['cr_client_new1']}`);
    expect(res.status).toBe(200);
  });
});
