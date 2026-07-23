import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { mountAppointmentRoutes } from '../src/routes/appointments';
import { mountSchedulingRoutes } from '../src/routes/scheduling';
import type { AuthUser } from '../src/auth';
import { makeApiClient, dataOf, errorOf } from './api_client';
import type { AppointmentResponse } from '../../shared/src/ssot/query-types';

// A professional offers a declared set of services; booking one they do not offer must fail on the
// server, not only in the booking screens. A professional who declares none is unconfigured rather
// than restricted, which is the reading the client uses too.

let pool: Pool;
let server: http.Server;
let baseUrl: string;
let currentUser: AuthUser;

const injectUser: express.RequestHandler = (req, _res, next) => {
  (req as express.Request & { user?: AuthUser }).user = currentUser;
  next();
};

const request = makeApiClient(() => baseUrl);

let bizId: number;
let otherBizId: number;
let adminId: number;
let restrictedProId: number;
let openProId: number;
let clientId: number;
let offeredSvcId: number;
let otherSvcId: number;
let foreignSvcId: number;

function nextMondayDate(): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  const daysUntilMonday = ((8 - d.getUTCDay()) % 7) || 7;
  d.setUTCDate(d.getUTCDate() + daysUntilMonday);
  return d.toISOString().slice(0, 10);
}
const MONDAY = nextMondayDate();

const staffUser = (): AuthUser => ({
  id: adminId,
  username: 'offer_admin',
  email: null,
  role: 'Admin',
  business_id: bizId,
  is_active: true,
  must_change_password: false,
});

const clientCaller = (): AuthUser => ({
  id: clientId,
  username: 'offer_client',
  email: null,
  role: 'Client',
  business_id: bizId,
  is_active: true,
  must_change_password: false,
});

async function seedUser(username: string, role: AuthUser['role'], businessId: number): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO auth.users
       (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ($1, $2, $3, 'h', 's', $4, $5, false) RETURNING id`,
    [username, `${username}@test.local`, username, role, businessId],
  );
  return Number(r.rows[0].id);
}

async function seedService(businessId: number, name: string): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
     VALUES ($1, $2, 30, '1000.00') RETURNING id`,
    [businessId, name],
  );
  return Number(r.rows[0].id);
}

// A Monday morning block that offers both services, so availability never masks the offering rule.
async function seedMondayBlock(professionalUserId: number, serviceIds: number[]): Promise<void> {
  const block = await pool.query<{ id: string }>(
    `INSERT INTO schedule_blocks (professional_user_id, weekday, start_time, end_time)
     VALUES ($1, 'mon', '09:00', '12:00') RETURNING id`,
    [professionalUserId],
  );
  for (const serviceId of serviceIds) {
    await pool.query(
      `INSERT INTO schedule_block_services (professional_user_id, schedule_block_id, service_id)
       VALUES ($1, $2, $3)`,
      [professionalUserId, block.rows[0].id, serviceId],
    );
  }
}

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const biz = await pool.query<{ id: string }>(
    `INSERT INTO businesses (name, cancellation_cutoff_hours) VALUES ('Offer Biz', 0) RETURNING id`,
  );
  bizId = Number(biz.rows[0].id);
  const otherBiz = await pool.query<{ id: string }>(
    `INSERT INTO businesses (name) VALUES ('Offer Other Biz') RETURNING id`,
  );
  otherBizId = Number(otherBiz.rows[0].id);

  adminId = await seedUser('offer_admin', 'Admin', bizId);
  restrictedProId = await seedUser('offer_pro_restricted', 'Professional', bizId);
  openProId = await seedUser('offer_pro_open', 'Professional', bizId);
  clientId = await seedUser('offer_client', 'Client', bizId);

  offeredSvcId = await seedService(bizId, 'Ofrecido');
  otherSvcId = await seedService(bizId, 'No ofrecido');
  foreignSvcId = await seedService(otherBizId, 'Ajeno');

  await seedMondayBlock(restrictedProId, [offeredSvcId, otherSvcId]);
  await seedMondayBlock(openProId, [offeredSvcId, otherSvcId]);

  // Only the restricted professional declares an offering; the open one declares none.
  await pool.query(
    `INSERT INTO professional_services (professional_user_id, service_id) VALUES ($1, $2)`,
    [restrictedProId, offeredSvcId],
  );

  const app = express();
  app.use(express.json());
  const guards = {
    auth: injectUser,
    passwordReady: ((_req, _res, next) => next()) as express.RequestHandler,
    audit: async () => {},
  };
  mountAppointmentRoutes(app, pool, guards);
  mountSchedulingRoutes(app, pool, guards);

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

function scheduleBody(professionalUserId: number, serviceId: number, start: string) {
  return {
    professional_user_id: professionalUserId,
    client_user_id: clientId,
    service_id: serviceId,
    date: MONDAY,
    start,
    duration_minutes: 30,
  };
}

describe('POST /api/appointments/schedule enforces the professional service offering', () => {
  test('a service the professional does not offer is rejected with 422', async () => {
    currentUser = staffUser();
    const res = await request<AppointmentResponse>('/api/appointments/schedule', {
      method: 'POST',
      body: scheduleBody(restrictedProId, otherSvcId, '09:00'),
    });
    expect(res.status).toBe(422);
    expect(errorOf(res).fields?.service_id).toBeTruthy();

    const stored = await pool.query(
      `SELECT 1 FROM appointments WHERE professional_user_id = $1 AND service_id = $2`,
      [restrictedProId, otherSvcId],
    );
    expect(stored.rows.length).toBe(0);
  });

  test('a service the professional does offer is accepted', async () => {
    currentUser = staffUser();
    const res = await request<AppointmentResponse>('/api/appointments/schedule', {
      method: 'POST',
      body: scheduleBody(restrictedProId, offeredSvcId, '09:30'),
    });
    expect(res.status).toBe(201);
    expect(Number(dataOf(res).service_id)).toBe(offeredSvcId);
  });

  test('a professional with no declared services is unrestricted, not unbookable', async () => {
    currentUser = staffUser();
    const res = await request<AppointmentResponse>('/api/appointments/schedule', {
      method: 'POST',
      body: scheduleBody(openProId, otherSvcId, '10:00'),
    });
    expect(res.status).toBe(201);
    expect(Number(dataOf(res).service_id)).toBe(otherSvcId);
  });

  test("another business's service is not found, never merely not offered", async () => {
    currentUser = staffUser();
    const res = await request<AppointmentResponse>('/api/appointments/schedule', {
      method: 'POST',
      body: scheduleBody(restrictedProId, foreignSvcId, '10:30'),
    });
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe('not_found');
  });
});

describe('the client-facing paths enforce the same offering', () => {
  test('POST /api/appointments/request rejects a service the professional does not offer', async () => {
    currentUser = clientCaller();
    const res = await request<AppointmentResponse>('/api/appointments/request', {
      method: 'POST',
      body: {
        professional_user_id: restrictedProId,
        service_id: otherSvcId,
        date: MONDAY,
        start: '11:00',
        duration_minutes: 30,
      },
    });
    expect(res.status).toBe(422);
    expect(errorOf(res).fields?.service_id).toBeTruthy();
  });

  test('POST /api/conflict-check rejects it too, so the preview agrees with the save', async () => {
    currentUser = staffUser();
    const res = await request<AppointmentResponse>('/api/conflict-check', {
      method: 'POST',
      body: {
        professional_user_id: restrictedProId,
        service_id: otherSvcId,
        date: MONDAY,
        start: '11:30',
        duration_minutes: 30,
      },
    });
    expect(res.status).toBe(422);
    expect(errorOf(res).fields?.service_id).toBeTruthy();
  });
});
