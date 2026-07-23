import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../src/migrate';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { resetTestDb, makeTestPool, APP_ROLE, assertAppRoleIsLeastPrivilege } from './helpers';
import { structure } from '../../shared/src/ssot/structure';
import type { CrudOp, TableStructure } from '../../shared/src/types/types';

// The generic engine issues real statements for every operation a table's descriptor enables. If
// the app role lacks the matching grant, that path 500s in production ("permission denied"). This
// guard asserts the least-privilege app role holds exactly the privileges the backend will need:
// derived from the descriptor for generic-CRUD tables, and from the workflow handlers' documented
// statement set for the protected ones the descriptor says nothing about.
let pool: Pool;

const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;
type Privilege = (typeof PRIVILEGES)[number];
type GrantCase = { key: string; table: string; privilege: Privilege };

// Which privilege the generic engine actually exercises for each declared operation. Reads may
// target a secret-free view (sqlReadTable); soft delete archives the row with an UPDATE, so the
// DELETE privilege is deliberately withheld and asserted absent instead.
function deriveCases(): { granted: GrantCase[]; withheld: GrantCase[]; keys: Set<string> } {
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

  const keys = new Set([...granted, ...withheld].map((c) => c.key));
  return { granted: dedupe(granted), withheld: dedupe(withheld), keys };
}

const { granted, withheld, keys: derivedKeys } = deriveCases();

// Protected tables carry no `crud` descriptor to derive from — their access is bespoke, owned by
// the workflow handlers in backend/src/db — so the statements each one issues are stated here.
// The posture is asserted in full (all four privileges, granted or withheld), because for the
// append-only tables it is the *absence* of a grant that enforces the guarantee. The exhaustiveness
// test below refuses to let a new table drift in unmentioned.
type BespokeGrants = { table: string; privileges: Privilege[] };
const BESPOKE_GRANTS: Record<string, BespokeGrants> = {
  // Login inserts, logout deletes; a session row is never rewritten in place.
  sessions:           { table: 'auth.sessions',      privileges: ['SELECT', 'INSERT', 'DELETE'] },
  // Tenant config is edited in-app; businesses themselves are provisioned out-of-band.
  businesses:         { table: 'businesses',         privileges: ['SELECT', 'UPDATE'] },
  // Booking inserts, lifecycle transitions update; cancelling is a state change, never a removal.
  appointments:       { table: 'appointments',       privileges: ['SELECT', 'INSERT', 'UPDATE'] },
  // Ending a series sets status='ended'; the rule row survives so past occurrences stay explicable.
  appointment_series: { table: 'appointment_series', privileges: ['SELECT', 'INSERT', 'UPDATE'] },
  // A grant row is presence-as-access: created by INSERT, revoked by DELETE, never mutated.
  calendar_grants:    { table: 'calendar_grants',    privileges: ['SELECT', 'INSERT', 'DELETE'] },
  // Append-only: corrections are posted as compensating entries so the balance stays reconstructible.
  ledger_entries:     { table: 'ledger_entries',     privileges: ['SELECT', 'INSERT'] },
  // Append-only: an audit trail the app role can rewrite is not an audit trail.
  audit_events:       { table: 'audit_events',       privileges: ['SELECT', 'INSERT'] },
};

const bespokeCases = Object.entries(BESPOKE_GRANTS).flatMap(([key, { table, privileges }]) =>
  PRIVILEGES.map((privilege) => ({
    key,
    table,
    privilege,
    expected: privileges.includes(privilege),
    verb: privileges.includes(privilege) ? 'may' : 'may NOT',
  })),
);

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();
  await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
  await assertAppRoleIsLeastPrivilege(pool);
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

describe('app-role grants on protected tables match their bespoke handlers', () => {
  it.each(bespokeCases)('$key: app role $verb $privilege $table', async ({ table, privilege, expected }) => {
    expect(await hasPrivilege(table, privilege)).toBe(expected);
  });
});

// A protected table added to the SSoT gets no derived case, so without this its grants would be
// asserted by nothing at all — the exact gap that let seven live tables go unchecked.
describe('every SSoT table has an asserted grant posture', () => {
  it('no table is missing from both the derived and the bespoke expectations', () => {
    const unasserted = Object.keys(structure.tables).filter(
      (key) => !derivedKeys.has(key) && !(key in BESPOKE_GRANTS),
    );
    expect(unasserted).toEqual([]);
  });

  it('the bespoke expectations name only tables that still exist and still lack generic CRUD', () => {
    const stale = Object.keys(BESPOKE_GRANTS).filter(
      (key) => !(key in structure.tables) || derivedKeys.has(key),
    );
    expect(stale).toEqual([]);
  });
});
