import http from 'node:http';
import express from 'express';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { mountLedgerRoutes } from '../src/routes/ledger';
import type { AuthUser } from '../src/auth';
import { makeApiClient, dataOf, metaOf, errorOf } from './api_client';
import type { JsonBody } from './api_client';
import type { LedgerEntryRow, Wire } from '../../shared/src/ssot/query-types';
import type { BalanceResult } from '../../shared/src/ssot/contracts/ledger';

let pool: Pool;
let server: http.Server;
let baseUrl: string;
let currentUser: AuthUser;

const injectUser: express.RequestHandler = (req, _res, next) => {
  (req as express.Request & { user?: AuthUser }).user = currentUser;
  next();
};

type LedgerRow = Wire<LedgerEntryRow>;
type ReqBody = JsonBody;

const request = makeApiClient(() => baseUrl);

function req<T>(method: 'GET' | 'POST', path: string, body?: ReqBody) {
  return request<T>(path, { method, body });
}

let bizId: number;
let adminId: number;
let proId: number;
let pro2Id: number;
let clientId: number;
let client2Id: number;
let recepNoGrantId: number;
let recepWithGrantId: number;
let svcId: number;
let apptId: number;

// Compute dates relative to now (mandatory — never hardcode calendar dates).
function nextMondayDate(): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  const daysUntilMonday = ((8 - d.getUTCDay()) % 7) || 7;
  d.setUTCDate(d.getUTCDate() + daysUntilMonday);
  return d.toISOString().slice(0, 10);
}
const MONDAY = nextMondayDate();
const BA_TZ = 'America/Argentina/Buenos_Aires';
const mondayAt = (hhmm: string) => `${MONDAY} ${hhmm}:00 ${BA_TZ}`;

async function seedUser(username: string, role: AuthUser['role']): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO auth.users
       (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
     VALUES ($1, $2, $3, 'h', 's', $4, $5, false)
     RETURNING id`,
    [username, `${username}@ledger.local`, username, role, bizId],
  );
  return Number(r.rows[0].id);
}

function asUser(id: number, role: AuthUser['role']): AuthUser {
  return {
    id,
    username: `u${id}`,
    email: null,
    role,
    business_id: bizId,
    is_active: true,
    must_change_password: false,
  };
}

// One charge per appointment is a schema invariant, so each test that posts a charge uses its own
// appointment. A distinct time per row keeps them from overlapping.
let apptSeq = 0;
async function seedAppt(clientUserId = clientId, professionalUserId = proId): Promise<number> {
  apptSeq += 1;
  const hh = String(6 + (apptSeq % 12)).padStart(2, '0');
  const mm = String((apptSeq * 7) % 60).padStart(2, '0');
  const r = await pool.query<{ id: string }>(
    `INSERT INTO appointments
       (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
     VALUES ($1, $2, $3, $4, 30, 'scheduled', '2500.00', false)
     RETURNING id`,
    [clientUserId, professionalUserId, svcId, mondayAt(`${hh}:${mm}`)],
  );
  return Number(r.rows[0].id);
}

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

  const biz = await pool.query<{ id: string }>(
    `INSERT INTO businesses (name, cancellation_cutoff_hours) VALUES ('Ledger Biz', 0) RETURNING id`,
  );
  bizId = Number(biz.rows[0].id);

  adminId = await seedUser('ledger_admin', 'Admin');
  proId = await seedUser('ledger_pro1', 'Professional');
  pro2Id = await seedUser('ledger_pro2', 'Professional');
  clientId = await seedUser('ledger_client1', 'Client');
  client2Id = await seedUser('ledger_client2', 'Client');
  recepNoGrantId = await seedUser('ledger_recep_no', 'Receptionist');
  recepWithGrantId = await seedUser('ledger_recep_yes', 'Receptionist');

  const svc = await pool.query<{ id: string }>(
    `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
     VALUES ($1, 'Consulta', 30, '2500.00') RETURNING id`,
    [bizId],
  );
  svcId = Number(svc.rows[0].id);

  const appt = await pool.query<{ id: string }>(
    `INSERT INTO appointments
       (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
     VALUES ($1, $2, $3, $4, 30, 'scheduled', '2500.00', false)
     RETURNING id`,
    [clientId, proId, svcId, mondayAt('09:00')],
  );
  apptId = Number(appt.rows[0].id);

  await pool.query(
    `INSERT INTO calendar_grants (professional_user_id, grantee_user_id) VALUES ($1, $2)`,
    [proId, recepWithGrantId],
  );

  const app = express();
  app.use(express.json());
  mountLedgerRoutes(app, pool, {
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
  await pool.end();
});

describe('POST /api/ledger — Admin write matrix', () => {
  test('admin creates a charge → 201 with audit event in same transaction', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId,
      appointment_id: apptId,
      entry_type: 'charge',
      amount_ars: '1000.00',
    });
    expect(res.status).toBe(201);
    expect(dataOf(res).entry_type).toBe('charge');
    expect(dataOf(res).amount_ars).toBe('1000.00');

    const audit = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit_events WHERE entity_id = $1 AND entity_type = 'ledger_entries'`,
      [dataOf(res).id],
    );
    expect(audit.rows.some((r) => r.event_type === 'ledger_charge_created')).toBe(true);
  });

  test('admin creates a payment → 201 with correct audit event type', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId,
      entry_type: 'payment',
      amount_ars: '500.00',
    });
    expect(res.status).toBe(201);
    expect(dataOf(res).entry_type).toBe('payment');

    const audit = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit_events WHERE entity_id = $1 AND entity_type = 'ledger_entries'`,
      [dataOf(res).id],
    );
    expect(audit.rows.some((r) => r.event_type === 'ledger_payment_created')).toBe(true);
  });

  test('admin creates adjustment_debit → 201', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId,
      entry_type: 'adjustment_debit',
      amount_ars: '200.00',
    });
    expect(res.status).toBe(201);
    expect(dataOf(res).entry_type).toBe('adjustment_debit');

    const audit = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit_events WHERE entity_id = $1 AND entity_type = 'ledger_entries'`,
      [dataOf(res).id],
    );
    expect(audit.rows.some((r) => r.event_type === 'ledger_adjustment_debit_created')).toBe(true);
  });

  test('admin creates adjustment_credit → 201', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId,
      entry_type: 'adjustment_credit',
      amount_ars: '100.00',
    });
    expect(res.status).toBe(201);
    expect(dataOf(res).entry_type).toBe('adjustment_credit');

    const audit = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit_events WHERE entity_id = $1 AND entity_type = 'ledger_entries'`,
      [dataOf(res).id],
    );
    expect(audit.rows.some((r) => r.event_type === 'ledger_adjustment_credit_created')).toBe(true);
  });

  test('a second charge on the same appointment is rejected (409) — one charge per appointment', async () => {
    currentUser = asUser(adminId, 'Admin');
    const appt = await seedAppt();
    const first = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId,
      appointment_id: appt,
      entry_type: 'charge',
      amount_ars: '300.00',
    });
    const second = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId,
      appointment_id: appt,
      entry_type: 'charge',
      amount_ars: '300.00',
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(errorOf(second).detail?.key).toBe('chargeAlreadyPosted');
  });

  test('an unlinked charge (no appointment_id) is unconstrained — several can coexist', async () => {
    currentUser = asUser(adminId, 'Admin');
    const r1 = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId, entry_type: 'charge', amount_ars: '77.00',
    });
    const r2 = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId, entry_type: 'charge', amount_ars: '77.00',
    });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
  });
});

describe('POST /api/ledger — charge prefill from appointment', () => {
  test('charge with appointment_id but no amount_ars prefills from booked price', async () => {
    currentUser = asUser(adminId, 'Admin');
    const appt = await seedAppt();
    const res = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId,
      appointment_id: appt,
      entry_type: 'charge',
    });
    expect(res.status).toBe(201);
    // Service booked at 2500.00; should be prefilled.
    expect(dataOf(res).amount_ars).toBe('2500.00');
  });

  test('charge with explicit amount_ars overrides the appointment price', async () => {
    currentUser = asUser(adminId, 'Admin');
    const appt = await seedAppt();
    const res = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId,
      appointment_id: appt,
      entry_type: 'charge',
      amount_ars: '999.00',
    });
    expect(res.status).toBe(201);
    expect(dataOf(res).amount_ars).toBe('999.00');
  });
});

describe('POST /api/ledger — Professional write matrix', () => {
  test('professional creates charge for own client → 201', async () => {
    currentUser = asUser(proId, 'Professional');
    const appt = await seedAppt();
    const res = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId,
      appointment_id: appt,
      entry_type: 'charge',
      amount_ars: '500.00',
    });
    expect(res.status).toBe(201);
  });

  test('professional creates charge for a client they have no appointment with → 403', async () => {
    currentUser = asUser(pro2Id, 'Professional');
    const res = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId, // client1 only has appointments with pro1, not pro2
      entry_type: 'charge',
      amount_ars: '500.00',
    });
    expect(res.status).toBe(403);
  });

  test('professional creates payment for own client → 201 (all types allowed)', async () => {
    currentUser = asUser(proId, 'Professional');
    const res = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId,
      entry_type: 'payment',
      amount_ars: '250.00',
    });
    expect(res.status).toBe(201);
  });
});

describe('POST /api/ledger — Receptionist write matrix', () => {
  test('receptionist with grant creates appointment-linked charge → 201', async () => {
    currentUser = asUser(recepWithGrantId, 'Receptionist');
    const appt = await seedAppt();
    const res = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId,
      appointment_id: appt,
      entry_type: 'charge',
      amount_ars: '100.00',
    });
    expect(res.status).toBe(201);
  });

  test('receptionist with grant creates appointment-linked payment → 201', async () => {
    currentUser = asUser(recepWithGrantId, 'Receptionist');
    const res = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId,
      appointment_id: apptId,
      entry_type: 'payment',
      amount_ars: '100.00',
    });
    expect(res.status).toBe(201);
  });

  test('receptionist standalone payment (no appointment_id) → 403', async () => {
    currentUser = asUser(recepWithGrantId, 'Receptionist');
    const res = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId,
      entry_type: 'payment',
      amount_ars: '100.00',
    });
    expect(res.status).toBe(403);
  });

  // An adjustment corrects a balance instead of settling a session, so it carries no appointment
  // and cannot be authorized against one. It is scoped to the clients whose ledger the grant
  // already exposes: adjusting a balance you may not read would outrank reading it.
  test.each(['adjustment_debit', 'adjustment_credit'])(
    'receptionist with a grant creates a standalone %s, no appointment needed',
    async (entryType) => {
      currentUser = asUser(recepWithGrantId, 'Receptionist');
      const res = await req<LedgerRow>('POST', '/api/ledger', {
        client_user_id: clientId,
        entry_type: entryType,
        amount_ars: '100.00',
      });
      expect(res.status).toBe(201);
      expect(dataOf(res).appointment_id).toBeNull();
      expect(dataOf(res).entry_type).toBe(entryType);
    },
  );

  test('receptionist without a grant on this client cannot adjust the balance → 403', async () => {
    currentUser = asUser(recepNoGrantId, 'Receptionist');
    const res = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId,
      entry_type: 'adjustment_credit',
      amount_ars: '100.00',
    });
    expect(res.status).toBe(403);
  });

  test('receptionist standalone charge (no appointment_id) → 403', async () => {
    currentUser = asUser(recepWithGrantId, 'Receptionist');
    const res = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId,
      entry_type: 'charge',
      amount_ars: '100.00',
    });
    expect(res.status).toBe(403);
  });

  test('receptionist without grant → 403', async () => {
    currentUser = asUser(recepNoGrantId, 'Receptionist');
    const res = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId,
      appointment_id: apptId,
      entry_type: 'charge',
      amount_ars: '100.00',
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/ledger — Client write forbidden', () => {
  test('client cannot create any ledger entry → 403', async () => {
    currentUser = asUser(clientId, 'Client');
    const res = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId,
      entry_type: 'charge',
      amount_ars: '100.00',
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/ledger — Validation (422 / 404)', () => {
  test('invalid entry_type → 422', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId,
      entry_type: 'adjustment', // old single-type, no longer valid
      amount_ars: '100.00',
    });
    expect(res.status).toBe(422);
  });

  test('negative amount format → 422', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId,
      entry_type: 'charge',
      amount_ars: '-50.00',
    });
    expect(res.status).toBe(422);
  });

  test('malformed amount (letters) → 422', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId,
      entry_type: 'charge',
      amount_ars: 'abc',
    });
    expect(res.status).toBe(422);
  });

  test('cross-tenant (unknown) client → 404', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: 999999,
      entry_type: 'charge',
      amount_ars: '100.00',
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/clients/:id/balance — signed balance formula', () => {
  // Uses a fresh client (client2) for an isolated balance calculation.
  let balanceClientId: number;

  beforeAll(async () => {
    // client2 starts with no entries; seed a known set for a deterministic balance.
    balanceClientId = client2Id;

    // Need an appointment linking pro1 → client2 so pro1 can bill them.
    const appt2 = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, $4, 30, 'scheduled', '1000.00', false)
       RETURNING id`,
      [balanceClientId, proId, svcId, mondayAt('10:00')],
    );
    const appt2Id = Number(appt2.rows[0].id);

    const insertEntry = (
      entryType: string,
      amount: string,
      apptIdParam?: number | null,
    ) =>
      pool.query(
        `INSERT INTO ledger_entries
           (client_user_id, appointment_id, entry_type, amount_ars, actor_user_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [balanceClientId, apptIdParam ?? null, entryType, amount, adminId],
      );

    // Charges/debits add to debt; payments/credits reduce it.
    // Expected balance: (1500 + 500) - (300 + 200) = 2000 - 500 = 1500.00
    await insertEntry('charge', '1500.00', appt2Id);
    await insertEntry('adjustment_debit', '500.00');
    await insertEntry('payment', '300.00');
    await insertEntry('adjustment_credit', '200.00');
  });

  test('balance is exact signed sum for seeded entries', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await req<BalanceResult>('GET', `/api/clients/${balanceClientId}/balance`);
    expect(res.status).toBe(200);
    // (1500 + 500) - (300 + 200) = 1500.00
    expect(Number(dataOf(res).balance_ars)).toBe(1500);
    expect(Number(dataOf(res).client_user_id)).toBe(balanceClientId);
  });

  test('partial payment reduces balance correctly', async () => {
    await pool.query(
      `INSERT INTO ledger_entries
         (client_user_id, entry_type, amount_ars, actor_user_id)
       VALUES ($1, 'payment', '1000.00', $2)`,
      [balanceClientId, adminId],
    );

    currentUser = asUser(adminId, 'Admin');
    const res = await req<BalanceResult>('GET', `/api/clients/${balanceClientId}/balance`);
    expect(res.status).toBe(200);
    // 1500 (previous) - 1000 (new payment) = 500.00
    expect(Number(dataOf(res).balance_ars)).toBe(500);
  });

  test('client can read own balance → 200', async () => {
    currentUser = asUser(balanceClientId, 'Client');
    const res = await req<BalanceResult>('GET', `/api/clients/${balanceClientId}/balance`);
    expect(res.status).toBe(200);
  });

  test('client cannot read another client balance → 403', async () => {
    // balanceClientId = client2; clientId = client1; using client1's session
    currentUser = asUser(clientId, 'Client');
    const res = await req<BalanceResult>('GET', `/api/clients/${balanceClientId}/balance`);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/clients/:id/ledger — paginated list', () => {
  test('admin reads paginated ledger for client → 200 with total', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await req<LedgerRow[]>('GET', `/api/clients/${clientId}/ledger?page=1&limit=10`);
    expect(res.status).toBe(200);
    expect(dataOf(res)).toBeInstanceOf(Array);
    expect(typeof metaOf(res).total).toBe('number');
    expect(metaOf(res).page).toBe(1);
    expect(dataOf(res)[0]).not.toHaveProperty('total_count');
  });

  test('an out-of-range page remains empty but preserves the filtered total', async () => {
    currentUser = asUser(adminId, 'Admin');
    const first = await req<LedgerRow[]>('GET', `/api/clients/${clientId}/ledger?page=1&limit=1`);
    const empty = await req<LedgerRow[]>('GET', `/api/clients/${clientId}/ledger?page=500&limit=1`);
    expect(empty.status).toBe(200);
    expect(dataOf(empty)).toEqual([]);
    expect(metaOf(empty).total).toBe(metaOf(first).total);
  });

  test('entries are ordered newest-first (created_at DESC)', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await req<LedgerRow[]>('GET', `/api/clients/${clientId}/ledger`);
    expect(res.status).toBe(200);
    const rows = dataOf(res);
    for (let i = 1; i < rows.length; i++) {
      expect(new Date(rows[i].created_at).getTime()).toBeLessThanOrEqual(
        new Date(rows[i - 1].created_at).getTime(),
      );
    }
  });

  test('client reads own ledger → 200', async () => {
    currentUser = asUser(clientId, 'Client');
    const res = await req<LedgerRow[]>('GET', `/api/clients/${clientId}/ledger`);
    expect(res.status).toBe(200);
  });

  test('client reads another client ledger → 403', async () => {
    currentUser = asUser(clientId, 'Client');
    const res = await req<LedgerRow[]>('GET', `/api/clients/${client2Id}/ledger`);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/clients/:id/ledger: appointment-derived description parts', () => {
  test('an entry linked to an appointment returns service/professional/when', async () => {
    currentUser = asUser(adminId, 'Admin');
    const appt = await seedAppt();
    const created = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId,
      appointment_id: appt,
      entry_type: 'charge',
      amount_ars: '444.00',
    });
    expect(created.status).toBe(201);

    const res = await req<LedgerRow[]>('GET', `/api/clients/${clientId}/ledger?limit=1000`);
    expect(res.status).toBe(200);
    const row = dataOf(res).find((r) => r.id === dataOf(created).id);
    expect(row).toBeDefined();
    expect(row?.service_name).toBe('Consulta');
    expect(row?.professional_name).toBe('ledger_pro1');
    expect(row?.appointment_when).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
  });

  test('an entry with no appointment returns null parts, not missing ones', async () => {
    currentUser = asUser(adminId, 'Admin');
    const created = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId,
      entry_type: 'payment',
      amount_ars: '55.00',
    });
    expect(created.status).toBe(201);

    const res = await req<LedgerRow[]>('GET', `/api/clients/${clientId}/ledger?limit=1000`);
    const row = dataOf(res).find((r) => r.id === dataOf(created).id);
    expect(row).toBeDefined();
    expect(row?.service_name).toBeNull();
    expect(row?.professional_name).toBeNull();
    expect(row?.appointment_when).toBeNull();
  });

  test('the paged total still matches once the name joins are present', async () => {
    currentUser = asUser(adminId, 'Admin');
    const full = await req<LedgerRow[]>('GET', `/api/clients/${clientId}/ledger?limit=1000`);
    const paged = await req<LedgerRow[]>('GET', `/api/clients/${clientId}/ledger?page=1&limit=2`);
    expect(paged.status).toBe(200);
    expect(metaOf(paged).total).toBe(metaOf(full).total);
    expect(dataOf(paged).length).toBeLessThanOrEqual(2);
  });
});

describe('ledger reads are business-scoped for Admin', () => {
  let biz2Id: number;
  let biz2AdminId: number;

  beforeAll(async () => {
    const biz2 = await pool.query<{ id: string }>(
      `INSERT INTO businesses (name, cancellation_cutoff_hours) VALUES ('Other Ledger Biz', 0) RETURNING id`,
    );
    biz2Id = Number(biz2.rows[0].id);
    const admin2 = await pool.query<{ id: string }>(
      `INSERT INTO auth.users
         (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
       VALUES ('ledger_admin_biz2', 'admin_biz2@ledger.local', 'admin_biz2', 'h', 's', 'Admin', $1, false)
       RETURNING id`,
      [biz2Id],
    );
    biz2AdminId = Number(admin2.rows[0].id);
  });

  function biz2Admin(): AuthUser {
    return {
      id: biz2AdminId,
      username: 'ledger_admin_biz2',
      email: null,
      role: 'Admin',
      business_id: biz2Id,
      is_active: true,
      must_change_password: false,
    };
  }

  test('admin from another business cannot read a foreign client balance → 404', async () => {
    currentUser = biz2Admin();
    const res = await req<BalanceResult>('GET', `/api/clients/${clientId}/balance`);
    expect(res.status).toBe(404);
  });

  test('admin from another business cannot read a foreign client ledger → 404', async () => {
    currentUser = biz2Admin();
    const res = await req<LedgerRow[]>('GET', `/api/clients/${clientId}/ledger`);
    expect(res.status).toBe(404);
  });

  test('same-business admin still reads the client balance → 200 (no regression)', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await req<BalanceResult>('GET', `/api/clients/${clientId}/balance`);
    expect(res.status).toBe(200);
  });
});

describe('ledger_entries immutability trigger', () => {
  let immutableEntryId: number;

  beforeAll(async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO ledger_entries
         (client_user_id, entry_type, amount_ars, actor_user_id)
       VALUES ($1, 'charge', '100.00', $2)
       RETURNING id`,
      [clientId, adminId],
    );
    immutableEntryId = Number(r.rows[0].id);
  });

  test('raw UPDATE on ledger_entries throws (forbid_ledger_mutation trigger)', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await expect(
        c.query(`UPDATE ledger_entries SET amount_ars = '999.00' WHERE id = $1`, [immutableEntryId]),
      ).rejects.toThrow();
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  test('raw DELETE on ledger_entries throws (forbid_ledger_mutation trigger)', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await expect(
        c.query(`DELETE FROM ledger_entries WHERE id = $1`, [immutableEntryId]),
      ).rejects.toThrow();
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });
});

describe("POST /api/ledger — prefill rejects an appointment not belonging to the charged client (WR-01)", () => {
  let otherClientApptId: number;

  beforeAll(async () => {
    const appt = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (client_user_id, professional_user_id, service_id, starts_at, duration_minutes, state, price, override_conflict)
       VALUES ($1, $2, $3, $4, 30, 'scheduled', '9999.00', false)
       RETURNING id`,
      [client2Id, proId, svcId, mondayAt('11:30')],
    );
    otherClientApptId = Number(appt.rows[0].id);
  });

  test('Admin charge on client1 using an appointment that belongs to client2 → 404', async () => {
    currentUser = asUser(adminId, 'Admin');
    const res = await req<LedgerRow>('POST', '/api/ledger', {
      client_user_id: clientId,       // billing client1
      appointment_id: otherClientApptId, // but the appointment belongs to client2
      entry_type: 'charge',
      // no amount_ars — would trigger prefill
    });
    expect(res.status).toBe(404);
  });
});
