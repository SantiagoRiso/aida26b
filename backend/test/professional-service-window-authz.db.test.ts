import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { mountGenericRoutes } from '../src/app';
import type { AuthUser } from '../src/auth';

// Per-service booking-window edit authz: only Admin / owning Professional / granted Receptionist
// may PUT professional_services, and only the window columns are writable.
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
let pro1: number;
let pro2: number;
let recepNoGrant: number;
let recepWithGrant: number;
let clientId: number;
let svc1: string;
let svc2: string;
let bindingId: string; // professional_services row: pro1 -> svc1

async function seedUser(username: string, role: string): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ($1, $2, $3, 'h', 's', $4, $5, false) RETURNING id`,
    [username, `${username}@test.local`, username, role, bizId]
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

// PUT the binding with an arbitrary body — used to prove that non-editable fields are rejected.
async function putRaw(id: string, body: Record<string, string | number | boolean | null>) {
  const res = await fetch(`${baseUrl}/api/professional_services/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.status;
}

async function postCreate(body: Record<string, string | number | boolean | null>) {
  const res = await fetch(`${baseUrl}/api/professional_services`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.status;
}

// The real window edit sends ONLY the editable columns — exactly what the frontend GenericForm
// submits (it drops editable:false / readonlyOnEdit columns from the edit payload). The owner is
// read from the existing row by the guard, so the caller's identity decides authz. Sending a
// non-editable column (an FK) is a 400 validation_error (see the last two tests), which is why the
// happy-path PUT must not include the FK columns.
async function putWindow(id: string, min: number | null, max: number | null) {
  return putRaw(id, { min_booking_days: min, max_booking_days: max });
}

async function readBinding(id: string) {
  const r = await pool.query<{ professional_user_id: string; service_id: string; min_booking_days: number | null; max_booking_days: number | null }>(
    `SELECT professional_user_id, service_id, min_booking_days, max_booking_days FROM professional_services WHERE id = $1`,
    [id]
  );
  return r.rows[0];
}

async function auditRows(eventType: string, entityId: number) {
  const r = await pool.query<{ actor_user_id: string; outcome: string }>(
    `SELECT actor_user_id, outcome FROM audit_events WHERE event_type = $1 AND entity_id = $2`,
    [eventType, entityId],
  );
  return r.rows;
}

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const biz = await pool.query<{ id: string }>(`INSERT INTO businesses (name) VALUES ('Window Biz') RETURNING id`);
  bizId = biz.rows[0].id;

  adminId = await seedUser('psw_admin', 'Admin');
  pro1 = await seedUser('psw_pro1', 'Professional');
  pro2 = await seedUser('psw_pro2', 'Professional');
  recepNoGrant = await seedUser('psw_recep_no', 'Receptionist');
  recepWithGrant = await seedUser('psw_recep_yes', 'Receptionist');
  clientId = await seedUser('psw_client', 'Client');

  await pool.query(`INSERT INTO calendar_grants (professional_user_id, grantee_user_id) VALUES ($1, $2)`, [pro1, recepWithGrant]);

  const s1 = await pool.query<{ id: string }>(
    `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars) VALUES ($1, 'Svc One', 30, '1000.00') RETURNING id`,
    [bizId]
  );
  svc1 = s1.rows[0].id;
  const s2 = await pool.query<{ id: string }>(
    `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars) VALUES ($1, 'Svc Two', 30, '1000.00') RETURNING id`,
    [bizId]
  );
  svc2 = s2.rows[0].id;

  const b = await pool.query<{ id: string }>(
    `INSERT INTO professional_services (professional_user_id, service_id) VALUES ($1, $2) RETURNING id`,
    [pro1, svc1]
  );
  bindingId = b.rows[0].id;

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

describe('professional_services per-service window edit authz', () => {
  test('Admin may set the window on any in-business binding', async () => {
    currentUser = asUser(adminId, 'Admin');
    expect(await putWindow(bindingId, 2, 30)).toBe(202);
    const row = await readBinding(bindingId);
    expect(row.min_booking_days).toBe(2);
    expect(row.max_booking_days).toBe(30);

    // The write is audited against a real actor, so the insert genuinely lands — this is the
    // path a fabricated actor id used to fail silently (a swallowed FK violation on audit_events).
    const audited = await auditRows('professional_services_updated', Number(bindingId));
    expect(audited).toHaveLength(1);
    expect(Number(audited[0].actor_user_id)).toBe(adminId);
    expect(audited[0].outcome).toBe('success');
  });

  test('the owning Professional may set their own binding window', async () => {
    currentUser = asUser(pro1, 'Professional');
    expect(await putWindow(bindingId, 1, 20)).toBe(202);
    expect((await readBinding(bindingId)).min_booking_days).toBe(1);
  });

  test('a peer Professional may NOT edit another professional\'s binding', async () => {
    currentUser = asUser(pro2, 'Professional');
    expect(await putWindow(bindingId, 5, 5)).toBe(403);
  });

  test('a Receptionist WITH a grant may edit the binding window', async () => {
    currentUser = asUser(recepWithGrant, 'Receptionist');
    expect(await putWindow(bindingId, 3, 40)).toBe(202);
    expect((await readBinding(bindingId)).max_booking_days).toBe(40);
  });

  test('a Receptionist WITHOUT a grant is forbidden', async () => {
    currentUser = asUser(recepNoGrant, 'Receptionist');
    expect(await putWindow(bindingId, 9, 9)).toBe(403);
  });

  test('a Client can never edit a binding window', async () => {
    currentUser = asUser(clientId, 'Client');
    expect(await putWindow(bindingId, 9, 9)).toBe(403);
  });

  test('the owner FK is not an accepted field on the window PUT (cannot be reassigned)', async () => {
    currentUser = asUser(adminId, 'Admin');
    expect(
      await putRaw(bindingId, { professional_user_id: String(pro2), min_booking_days: 1, max_booking_days: 10 }),
    ).toBe(400);
    expect((await readBinding(bindingId)).professional_user_id).toBe(String(pro1)); // owner unchanged
  });

  test('the service_id is not an accepted field on the window PUT (not writable)', async () => {
    currentUser = asUser(adminId, 'Admin');
    expect(
      await putRaw(bindingId, { service_id: svc2, min_booking_days: 1, max_booking_days: 10 }),
    ).toBe(400);
    expect((await readBinding(bindingId)).service_id).toBe(svc1); // unchanged
  });

  // The FK pair is readonlyOnEdit — frozen after create, but it MUST be settable AT create, else no
  // offering can be made. This exercises the generic POST that the frontend's offer checklist calls.
  test('Admin may CREATE an offering with the full object (FK pair settable at create)', async () => {
    currentUser = asUser(adminId, 'Admin');
    expect(
      await postCreate({ professional_user_id: String(pro2), service_id: svc2, min_booking_days: null, max_booking_days: null }),
    ).toBe(201);
    const r = await pool.query<{ id: string }>(
      `SELECT id FROM professional_services WHERE professional_user_id = $1 AND service_id = $2`,
      [pro2, svc2],
    );
    expect(r.rowCount).toBe(1);

    // Same guarantee as the PUT case above: the create audit insert must actually land, not just
    // be attempted with an actor that can never satisfy audit_events' FK.
    const audited = await auditRows('professional_services_created', Number(r.rows[0].id));
    expect(audited).toHaveLength(1);
    expect(Number(audited[0].actor_user_id)).toBe(adminId);
    expect(audited[0].outcome).toBe('success');
  });

  test('create still requires the full object (a missing service FK is rejected)', async () => {
    currentUser = asUser(adminId, 'Admin');
    expect(
      await postCreate({ professional_user_id: String(pro1), min_booking_days: null, max_booking_days: null }),
    ).toBe(400);
  });
});
