import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Request } from 'express';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool, makeAppPool } from './helpers';
import { createAuditWriter } from '../src/audit';
import { setAuthenticatedUser } from '../src/session';
import { auditInTx } from '../src/routes/appointment-authz';
import { withTransaction } from '../src/db/core';
import type { AuthUser } from '../src/auth';

// The gap (M13): denial events written through the pool-based writer used to drop any actor whose
// business resolved to null — so a super-admin (Admin with no business), the one role with
// cross-tenant power, left no trace when it was refused. These tests pin that a tenantless *actor's*
// denial now lands with business_id = NULL, that a tenant-scoped actor is unchanged, and that the
// two sites deliberately left to drop still drop.

let pool: Pool;
let appPool: Pool;
let bizId: number;
let superAdminId: number;
let tenantProfId: number;

async function makeUser(role: string, businessId: number | null): Promise<number> {
  const uname = `deny_${role}_${businessId ?? 'null'}`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id)
     VALUES ($1, $2, $3, 'x', 'x', $4, $5)
     RETURNING id`,
    [uname, `${uname}@test.local`, uname, role, businessId],
  );
  return Number(rows[0].id);
}

// audit_events is append-only (trigger-enforced), so a test reads only what landed after its own
// watermark rather than truncating.
async function watermark(): Promise<number> {
  const { rows } = await pool.query<{ max: string | null }>(`SELECT max(id)::text AS max FROM audit_events`);
  return Number(rows[0].max ?? 0);
}

type Row = { business_id: string | null; actor_user_id: string | null; event_type: string; outcome: string };

async function rowsSince(since: number): Promise<Row[]> {
  const { rows } = await pool.query<Row>(
    `SELECT business_id, actor_user_id, event_type, outcome
       FROM audit_events WHERE id > $1 ORDER BY id`,
    [since],
  );
  return rows;
}

// A minimal Request carrying only what the writer touches: req.ip and the attached session user.
function reqFor(user?: AuthUser): Request {
  const req = { ip: '203.0.113.7' } as Request;
  if (user) setAuthenticatedUser(req, user);
  return req;
}

function authUser(id: number, role: AuthUser['role'], businessId: number | null): AuthUser {
  return {
    id,
    username: `u${id}`,
    email: null,
    role,
    business_id: businessId,
    is_active: true,
    must_change_password: false,
  };
}

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
  appPool = makeAppPool();

  const biz = await pool.query<{ id: string }>(`INSERT INTO businesses (name) VALUES ('Deny Biz') RETURNING id`);
  bizId = Number(biz.rows[0].id);

  superAdminId = await makeUser('Admin', null);
  tenantProfId = await makeUser('Professional', bizId);
}, 30000);

afterAll(async () => {
  await appPool.end();
  await pool.end();
});

describe('tenantless-actor denials are recorded, not dropped', () => {
  test('a super-admin (Admin, no business) denial lands with business_id NULL', async () => {
    const since = await watermark();
    const audit = createAuditWriter(appPool);

    await audit(reqFor(authUser(superAdminId, 'Admin', null)), 'permission_denied', 'denied', {
      path: '/api/professionals/1',
      method: 'DELETE',
    });

    const rows = await rowsSince(since);
    expect(rows).toHaveLength(1);
    expect(rows[0].business_id).toBeNull();
    expect(Number(rows[0].actor_user_id)).toBe(superAdminId);
    expect(rows[0].event_type).toBe('permission_denied');
    expect(rows[0].outcome).toBe('denied');
  });

  test('a tenant-scoped actor denial is still attributed to its business, unchanged', async () => {
    const since = await watermark();
    const audit = createAuditWriter(appPool);

    await audit(reqFor(authUser(tenantProfId, 'Professional', bizId)), 'permission_denied', 'denied', {
      path: '/api/businesses/1',
      method: 'DELETE',
    });

    const rows = await rowsSince(since);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].business_id)).toBe(bizId);
    expect(Number(rows[0].actor_user_id)).toBe(tenantProfId);
  });
});

describe('sites deliberately left to drop still write nothing', () => {
  test('anti-DoS gate: an unauthenticated request (no actor, no override) writes no row', async () => {
    const since = await watermark();
    const audit = createAuditWriter(appPool);

    // No session user attached and no explicit scope: the writer must drop rather than turn an
    // anonymous, unbounded-volume denial into an append-only insert.
    await audit(reqFor(), 'permission_denied', 'denied', { path: '/api/anything', method: 'DELETE' });

    expect(await rowsSince(since)).toHaveLength(0);
  });

  test('auditInTx drops a tenantless actor but records a tenant-scoped one', async () => {
    // Positive control first: proves the in-tx writer does land a row, so the null-business assertion
    // below is the guard doing its job, not a broken harness.
    const since1 = await watermark();
    await withTransaction(appPool, async (tx) => {
      await auditInTx(tx, authUser(tenantProfId, 'Professional', bizId), 'appointment_scheduled', 'success');
    });
    expect(await rowsSince(since1)).toHaveLength(1);

    const since2 = await watermark();
    await withTransaction(appPool, async (tx) => {
      await auditInTx(tx, authUser(superAdminId, 'Admin', null), 'appointment_scheduled', 'success');
    });
    expect(await rowsSince(since2)).toHaveLength(0);
  });
});
