import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';

import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { query } from '../src/db/core';
import { buildDeleteStatement } from '../src/db/generic';
import { deactivateUser, deleteUserSessions, findUser, findContactOnlyClient } from '../src/db/users';
import { createSession, loadSessionUser } from '../src/db/auth';
import { newSessionToken, hashToken } from '../src/auth';
import { getPkFields } from '../../shared/src/utils/utils';
import type { ScopeConditionsInput } from '../src/db/scope';

// Two paths archive a user: the generic DELETE the Clientes/Profesionales screens call, compiled
// from the SSoT descriptor, and the bespoke /api/admin/users/:id/deactivate the Usuarios screen
// calls. They act on the same physical row, so they must leave it in the same state — a reader
// looking at auth.users cannot tell which screen was used, and no guard may behave differently.
const noScope: ScopeConditionsInput = { businessWhere: '', businessParams: [] };

type ArchiveState = {
  is_active: boolean;
  archived: boolean;
  deleted_by_user_id: string | null;
  updated_after_insert: boolean;
};

describe('the two archival paths agree on what "archived" means', () => {
  let pool: Pool;
  let bizId: number;
  let actorId: number;
  let seq = 0;

  beforeAll(async () => {
    await resetTestDb();
    pool = makeTestPool();
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    const biz = await pool.query<{ id: string }>(
      `INSERT INTO businesses (name) VALUES ('Archive Parity Biz') RETURNING id`,
    );
    bizId = Number(biz.rows[0].id);
    actorId = await seedClient({ credentialed: true });
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedClient(opts: { credentialed: boolean }): Promise<number> {
    seq += 1;
    const name = `archive_parity_${seq}`;
    const row = await pool.query<{ id: string }>(
      `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role, business_id)
       VALUES ($1, $2, 'Archive Parity', 'h', 's', 'Client', $3) RETURNING id`,
      [opts.credentialed ? name : null, `${name}@test.local`, bizId],
    );
    return Number(row.rows[0].id);
  }

  async function stateOf(userId: number): Promise<ArchiveState> {
    const row = await pool.query<{
      is_active: boolean;
      archived: boolean;
      deleted_by_user_id: string | null;
      updated_after_insert: boolean;
    }>(
      `SELECT is_active,
              deleted_at IS NOT NULL      AS archived,
              deleted_by_user_id,
              updated_at > created_at     AS updated_after_insert
         FROM auth.users WHERE id = $1`,
      [userId],
    );
    return row.rows[0];
  }

  // The literal SQL routes/delete.ts executes for DELETE /api/clients/:id.
  async function archiveGenerically(userId: number): Promise<number> {
    const pkFields = getPkFields('clients');
    const { text, values } = buildDeleteStatement(
      'clients',
      'auth.users',
      pkFields,
      [userId],
      noScope,
      actorId,
    );
    const rows = await query(pool, text, values);
    return rows.length;
  }

  test('the generic delete and the bespoke deactivation leave an identical row state', async () => {
    const genericId = await seedClient({ credentialed: true });
    const bespokeId = await seedClient({ credentialed: true });

    expect(await archiveGenerically(genericId)).toBe(1);

    const bespoke = await deactivateUser(pool, { userId: bespokeId, scope: { kind: 'tenant', businessId: bizId }, actorId });
    expect(bespoke).not.toBeNull();

    const expected: ArchiveState = {
      is_active: false,
      archived: true,
      deleted_by_user_id: String(actorId),
      updated_after_insert: true,
    };

    expect(await stateOf(genericId)).toEqual(expected);
    expect(await stateOf(bespokeId)).toEqual(expected);
  });

  test('both paths refuse to archive an already-archived user', async () => {
    const genericId = await seedClient({ credentialed: true });
    const bespokeId = await seedClient({ credentialed: true });

    expect(await archiveGenerically(genericId)).toBe(1);
    expect(await archiveGenerically(genericId)).toBe(0);

    expect(
      await deactivateUser(pool, { userId: bespokeId, scope: { kind: 'tenant', businessId: bizId }, actorId }),
    ).not.toBeNull();
    expect(
      await deactivateUser(pool, { userId: bespokeId, scope: { kind: 'tenant', businessId: bizId }, actorId }),
    ).toBeNull();

    // Cross-path: an account archived through one screen is gone for the other one too.
    expect(
      await deactivateUser(pool, { userId: genericId, scope: { kind: 'tenant', businessId: bizId }, actorId }),
    ).toBeNull();
  });

  // These guards ask is_active, not deleted_at. Before the descriptor carried activeColumn a
  // generically-deleted client stayed bookable and could still have login enabled on it.
  test('a generically deleted client is no longer usable by the is_active guards', async () => {
    const userId = await seedClient({ credentialed: true });
    expect(await findUser(pool, { id: userId, activeOnly: true })).not.toBeNull();

    await archiveGenerically(userId);

    expect(await findUser(pool, { id: userId, activeOnly: true })).toBeNull();
  });

  test('a generically deleted contact-only client can no longer have login enabled', async () => {
    const userId = await seedClient({ credentialed: false });
    expect(await findContactOnlyClient(pool, { userId, scope: { kind: 'tenant', businessId: bizId } })).not.toBeNull();

    await archiveGenerically(userId);

    expect(await findContactOnlyClient(pool, { userId, scope: { kind: 'tenant', businessId: bizId } })).toBeNull();
  });

  // The one deliberate asymmetry: only the bespoke route purges session rows, because revoking
  // sessions from the generic engine would make the descriptor→SQL compiler know about
  // auth.sessions. Both paths still end the session on the very next request.
  test('sessions stop validating on both paths; only the bespoke route also purges the rows', async () => {
    const genericId = await seedClient({ credentialed: true });
    const bespokeId = await seedClient({ credentialed: true });

    const genericToken = newSessionToken();
    const bespokeToken = newSessionToken();
    await createSession(pool, genericId, hashToken(genericToken));
    await createSession(pool, bespokeId, hashToken(bespokeToken));

    expect(await loadSessionUser(pool, hashToken(genericToken))).not.toBeNull();
    expect(await loadSessionUser(pool, hashToken(bespokeToken))).not.toBeNull();

    await archiveGenerically(genericId);
    await deactivateUser(pool, { userId: bespokeId, scope: { kind: 'tenant', businessId: bizId }, actorId });
    await deleteUserSessions(pool, bespokeId);

    expect(await loadSessionUser(pool, hashToken(genericToken))).toBeNull();
    expect(await loadSessionUser(pool, hashToken(bespokeToken))).toBeNull();

    const rows = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM auth.sessions WHERE user_id = ANY($1)`,
      [[genericId, bespokeId]],
    );
    expect(rows.rows.map((r) => Number(r.user_id))).toEqual([genericId]);
  });
});
