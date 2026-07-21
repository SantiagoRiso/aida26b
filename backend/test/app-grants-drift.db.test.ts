import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool } from './helpers';
import { structure } from '../../shared/src/ssot/structure';
import type { CrudOp, TableStructure } from '../../shared/src/types/types';

// The generic engine issues real statements for every operation a table's descriptor enables. If
// the app role lacks the matching grant, that path 500s in production ("permission denied") — yet
// the authz db tests mount the server on the SUPERUSER pool, so they never exercise grants and
// stay green. This guard closes that blind spot: for every SSoT-declared operation, assert the
// least-privilege app role holds exactly the privilege the engine will need.
let pool: Pool;
const APP_ROLE = process.env.DB_USER ?? 'aida26_user';

type Privilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
type GrantCase = { key: string; table: string; privilege: Privilege };

// Which privilege the generic engine actually exercises for each declared operation. Reads may
// target a secret-free view (sqlReadTable); soft delete archives the row with an UPDATE, so the
// DELETE privilege is deliberately withheld and asserted absent instead.
function deriveCases(): { granted: GrantCase[]; withheld: GrantCase[] } {
  const granted: GrantCase[] = [];
  const withheld: GrantCase[] = [];

  for (const [key, table] of Object.entries(structure.tables) as [string, TableStructure][]) {
    const crud = table.crud;
    if (!crud) continue;

    const writeTable = table.sqlTable ?? key;
    const readTable = table.sqlReadTable ?? writeTable;
    const enabled = (op: CrudOp) => crud[op] === true;

    if (enabled('read')) granted.push({ key, table: readTable, privilege: 'SELECT' });
    if (enabled('create')) granted.push({ key, table: writeTable, privilege: 'INSERT' });
    if (enabled('update')) granted.push({ key, table: writeTable, privilege: 'UPDATE' });
    if (enabled('delete')) {
      if (table.softDelete) {
        granted.push({ key, table: writeTable, privilege: 'UPDATE' });
        withheld.push({ key, table: writeTable, privilege: 'DELETE' });
      } else {
        granted.push({ key, table: writeTable, privilege: 'DELETE' });
      }
    }
  }

  const dedupe = (cases: GrantCase[]) => {
    const seen = new Set<string>();
    return cases.filter((c) => {
      const id = `${c.key}|${c.table}|${c.privilege}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  };

  return { granted: dedupe(granted), withheld: dedupe(withheld) };
}

const { granted, withheld } = deriveCases();

// has_table_privilege answers true for any superuser and for the owner of the table, so running
// these assertions against such a role proves nothing. Refuse to run rather than report a green
// that only means "the role is too powerful to test".
async function assertRoleIsLeastPrivilege(): Promise<void> {
  const { rows } = await pool.query<{ rolsuper: boolean }>(
    `SELECT rolsuper FROM pg_roles WHERE rolname = $1`,
    [APP_ROLE],
  );
  if (rows.length === 0) {
    throw new Error(
      `App role '${APP_ROLE}' (DB_USER) does not exist. The grant assertions cannot run.`,
    );
  }
  if (rows[0].rolsuper) {
    throw new Error(
      `App role '${APP_ROLE}' (DB_USER) is a SUPERUSER, so has_table_privilege() returns true ` +
        `unconditionally and every grant assertion below would pass without proving anything. ` +
        `Point DB_USER at the least-privilege application role (a two-role setup, as created by ` +
        `database/bootstrap.sh), distinct from POSTGRES_SUPERUSER and DB_OWNER_USER.`,
    );
  }

  const { rows: owned } = await pool.query<{ table_name: string }>(
    `SELECT schemaname || '.' || tablename AS table_name
       FROM pg_tables
      WHERE tableowner = $1 AND schemaname IN ('public', 'auth')
      ORDER BY 1`,
    [APP_ROLE],
  );
  if (owned.length > 0) {
    throw new Error(
      `App role '${APP_ROLE}' (DB_USER) owns migrated tables (${owned
        .map((r) => r.table_name)
        .join(', ')}), and a table owner holds every privilege implicitly. Migrations must run as ` +
        `the schema-owner role (DB_OWNER_USER), never as the application role.`,
    );
  }
}

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
  await assertRoleIsLeastPrivilege();
});

afterAll(async () => {
  await pool.end();
});

async function hasPrivilege(table: string, privilege: Privilege): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>(
    `SELECT has_table_privilege($1, $2, $3) AS ok`,
    [APP_ROLE, table, privilege],
  );
  return rows[0].ok;
}

describe('app-role grants match the SSoT crud policies', () => {
  it.each(granted)('$key: app role may $privilege $table', async ({ table, privilege }) => {
    expect(await hasPrivilege(table, privilege)).toBe(true);
  });
});

// Withholding DELETE is what makes soft delete enforceable at the database level rather than by
// app-code convention; a grant here would silently allow rows to be physically removed.
describe('app-role grants withheld by design', () => {
  it.each(withheld)('$key: app role may NOT $privilege $table', async ({ table, privilege }) => {
    expect(await hasPrivilege(table, privilege)).toBe(false);
  });
});
