// Integration tests for the scheduler schema against a freshly migrated database.
import { test, assert, expect } from 'vitest';
import { Pool } from 'pg';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { runMigrations } from '../src/migrate';
import { resetTestDb, makeTestPool } from './helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function tableExists(pool: Pool, schema: string, name: string): Promise<boolean> {
  const r = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2
     ) AS exists`,
    [schema, name]
  );
  return r.rows[0].exists;
}

async function columnExists(
  pool: Pool,
  schema: string,
  table: string,
  column: string
): Promise<boolean> {
  const r = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
     ) AS exists`,
    [schema, table, column]
  );
  return r.rows[0].exists;
}

async function fkExists(
  pool: Pool,
  fromSchema: string,
  fromTable: string,
  columnName: string
): Promise<boolean> {
  const r = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM   information_schema.referential_constraints rc
       JOIN   information_schema.key_column_usage kcu
              ON kcu.constraint_name = rc.constraint_name
              AND kcu.constraint_schema = rc.constraint_schema
       WHERE  kcu.table_schema = $1
         AND  kcu.table_name   = $2
         AND  kcu.column_name  = $3
     ) AS exists`,
    [fromSchema, fromTable, columnName]
  );
  return r.rows[0].exists;
}

async function checkConstraintExists(
  pool: Pool,
  schema: string,
  table: string,
  pattern: string
): Promise<boolean> {
  const r = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.check_constraints cc
       JOIN   information_schema.table_constraints tc
              ON tc.constraint_name = cc.constraint_name
              AND tc.constraint_schema = cc.constraint_schema
       WHERE  tc.table_schema = $1
         AND  tc.table_name   = $2
         AND  cc.check_clause ILIKE $3
     ) AS exists`,
    [schema, table, `%${pattern}%`]
  );
  return r.rows[0].exists;
}

// ---------------------------------------------------------------------------
// Test suite — runs on a fresh database each test to ensure isolation
// ---------------------------------------------------------------------------

test('scheduler-schema: applies all migrations to a fresh database without error', async () => {
  await resetTestDb();
  const pool = makeTestPool();
  try {
    const applied = await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
    // Must apply at least our scheduler cutover migration (file count ≥ 1)
    assert.ok(applied >= 1, `Expected at least 1 migration to apply, got ${applied}`);
  } finally {
    await pool.end();
  }
});

test('scheduler-schema: academic tables do not exist after migration', async () => {
  await resetTestDb();
  const pool = makeTestPool();
  try {
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
    assert.equal(await tableExists(pool, 'public', 'students'),    false, 'students table must not exist');
    assert.equal(await tableExists(pool, 'public', 'subjects'),    false, 'subjects table must not exist');
    assert.equal(await tableExists(pool, 'public', 'enrollments'), false, 'enrollments table must not exist');
  } finally {
    await pool.end();
  }
});

test('scheduler-schema: academic auth.audit_log does not exist after migration', async () => {
  await resetTestDb();
  const pool = makeTestPool();
  try {
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
    assert.equal(await tableExists(pool, 'auth', 'audit_log'), false, 'auth.audit_log must not exist');
  } finally {
    await pool.end();
  }
});

test('scheduler-schema: auth.users has no student_numero_libreta column', async () => {
  await resetTestDb();
  const pool = makeTestPool();
  try {
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
    assert.equal(
      await columnExists(pool, 'auth', 'users', 'student_numero_libreta'),
      false,
      'auth.users must not have student_numero_libreta column'
    );
  } finally {
    await pool.end();
  }
});

test('scheduler-schema: all required scheduler tables exist', async () => {
  await resetTestDb();
  const pool = makeTestPool();
  try {
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    const requiredPublicTables = [
      'businesses',
      'clients',
      'professionals',
      'resources',
      'services',
      'client_professional_services',
      'schedules',
      'schedule_exceptions',
      'appointments',
      'ledger_entries',
      'audit_events',
      'calendar_grants',
    ];

    for (const t of requiredPublicTables) {
      assert.equal(
        await tableExists(pool, 'public', t),
        true,
        `Required scheduler table 'public.${t}' is missing`
      );
    }

    // Auth schema scheduler tables
    assert.equal(await tableExists(pool, 'auth', 'users'),    true, 'auth.users must exist');
    assert.equal(await tableExists(pool, 'auth', 'sessions'), true, 'auth.sessions must exist');
  } finally {
    await pool.end();
  }
});

test('scheduler-schema: removed tables do not exist after migration', async () => {
  await resetTestDb();
  const pool = makeTestPool();
  try {
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    const removedTables = [
      'availability_blocks',
      'availability_exceptions',
      'professional_services',
      'appointment_resources',
    ];

    for (const t of removedTables) {
      assert.equal(
        await tableExists(pool, 'public', t),
        false,
        `Removed table 'public.${t}' must not exist`
      );
    }

    // resources.resource_type was dropped in the redesign.
    assert.equal(
      await columnExists(pool, 'public', 'resources', 'resource_type'),
      false,
      'resources.resource_type column must not exist'
    );
  } finally {
    await pool.end();
  }
});

test('scheduler-schema: businesses supports timezone and ARS currency_code', async () => {
  await resetTestDb();
  const pool = makeTestPool();
  try {
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    assert.equal(await columnExists(pool, 'public', 'businesses', 'timezone'),      true, 'businesses must have timezone column');
    assert.equal(await columnExists(pool, 'public', 'businesses', 'currency_code'), true, 'businesses must have currency_code column');

    // Insert a business with defaults to verify ARS/timezone defaults work
    const result = await pool.query<{ timezone: string; currency_code: string }>(
      `INSERT INTO businesses (name) VALUES ('Test Business') RETURNING timezone, currency_code`
    );
    assert.equal(result.rows[0].timezone,      'America/Argentina/Buenos_Aires', 'default timezone should be ARS zone');
    assert.equal(result.rows[0].currency_code.trim(), 'ARS', 'default currency_code should be ARS');

    // Verify ARS check constraint prevents other currencies
    await expect(
      pool.query(`INSERT INTO businesses (name, currency_code) VALUES ('Bad', 'USD')`)
    ).rejects.toThrow();
  } finally {
    await pool.end();
  }
});

test('scheduler-schema: business-owned tables have business_id column', async () => {
  await resetTestDb();
  const pool = makeTestPool();
  try {
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    // business_id lives only on direct-owner tables. Derived tables reach the
    // business through a parent.
    const businessOwnedTables = [
      'clients',
      'professionals',
      'resources',
      'services',
      'audit_events',
    ];

    for (const t of businessOwnedTables) {
      assert.equal(
        await columnExists(pool, 'public', t, 'business_id'),
        true,
        `Business-owned table '${t}' must have business_id column`
      );
    }

    // Derived tables must NOT carry their own business_id.
    const derivedTables = [
      'appointments',
      'ledger_entries',
      'calendar_grants',
      'schedules',
      'schedule_exceptions',
      'client_professional_services',
    ];

    for (const t of derivedTables) {
      assert.equal(
        await columnExists(pool, 'public', t, 'business_id'),
        false,
        `Derived table '${t}' must not have business_id column`
      );
    }
  } finally {
    await pool.end();
  }
});

test('scheduler-schema: soft-deletable core tables have deleted_at and deleted_by_user_id', async () => {
  await resetTestDb();
  const pool = makeTestPool();
  try {
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    const softDeletableTables: Array<[string, string]> = [
      ['auth', 'users'],
      ['public', 'clients'],
      ['public', 'professionals'],
      ['public', 'services'],
      ['public', 'resources'],
    ];

    for (const [schema, table] of softDeletableTables) {
      assert.equal(
        await columnExists(pool, schema, table, 'deleted_at'),
        true,
        `${schema}.${table} must have deleted_at column`
      );
      assert.equal(
        await columnExists(pool, schema, table, 'deleted_by_user_id'),
        true,
        `${schema}.${table} must have deleted_by_user_id column`
      );
    }
  } finally {
    await pool.end();
  }
});

test('scheduler-schema: D1-compatible auth.users has business_id and D1 role check', async () => {
  await resetTestDb();
  const pool = makeTestPool();
  try {
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    assert.equal(await columnExists(pool, 'auth', 'users', 'business_id'), true, 'auth.users must have business_id');
    assert.equal(await columnExists(pool, 'auth', 'users', 'role'),        true, 'auth.users must have role column');

    // Verify role check constraint accepts D1 roles
    const validRoles = ['Admin', 'Professional', 'Receptionist', 'Client'];
    for (const role of validRoles) {
      const r = await pool.query(
        `INSERT INTO auth.users (username, email, password_hash, password_salt, role)
         VALUES ($1, $2, 'hash', 'salt', $3) RETURNING id`,
        [`testuser_${role}`, `${role}@test.com`, role]
      );
      assert.equal(r.rows.length, 1, `D1 role '${role}' should be accepted`);
    }

    // Verify old academic roles are rejected
    await expect(
      pool.query(
        `INSERT INTO auth.users (username, email, password_hash, password_salt, role)
         VALUES ('oldadmin', 'admin@old.com', 'hash', 'salt', 'admin')`
      )
    ).rejects.toThrow();
  } finally {
    await pool.end();
  }
});

test('scheduler-schema: FK constraints are valid — businesses referenced correctly', async () => {
  await resetTestDb();
  const pool = makeTestPool();
  try {
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    // Direct-owner tables reference businesses via business_id.
    assert.equal(await fkExists(pool, 'public', 'clients', 'business_id'),       true, 'clients.business_id FK must exist');
    assert.equal(await fkExists(pool, 'public', 'professionals', 'business_id'), true, 'professionals.business_id FK must exist');
    assert.equal(await fkExists(pool, 'public', 'resources', 'business_id'),     true, 'resources.business_id FK must exist');
    assert.equal(await fkExists(pool, 'public', 'services', 'business_id'),      true, 'services.business_id FK must exist');
    assert.equal(await fkExists(pool, 'public', 'audit_events', 'business_id'),  true, 'audit_events.business_id FK must exist');
    assert.equal(await fkExists(pool, 'auth', 'users', 'business_id'),           true, 'auth.users.business_id FK must exist');
  } finally {
    await pool.end();
  }
});

test('scheduler-schema: protected tables have restricted grants for aida26_user', async () => {
  await resetTestDb();
  const pool = makeTestPool();
  try {
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    // Check whether aida26_user is the superuser (single-role Docker environment).
    // In that case, the grants test is not meaningful: superusers bypass privilege checks.
    const roleResult = await pool.query<{ rolsuper: boolean }>(
      `SELECT rolsuper FROM pg_roles WHERE rolname = 'aida26_user'`
    );
    const isSuperuser = roleResult.rows.length > 0 && roleResult.rows[0].rolsuper;

    if (isSuperuser) {
      // Single-role Docker environment: aida26_user IS the connected superuser.
      // Grants posture check is not meaningful; superusers bypass ALL privilege checks.
      console.log('INFO: aida26_user is a PostgreSQL superuser — skipping grant posture checks (single-role Docker environment)');
      return;
    }

    // In two-role environments, verify protected tables lack INSERT/UPDATE/DELETE for aida26_user
    const protectedTables = [
      'calendar_grants',
      'appointments',
      'ledger_entries',
      'audit_events',
    ];

    for (const t of protectedTables) {
      const r = await pool.query<{ privilege_type: string }>(
        `SELECT privilege_type
         FROM   information_schema.role_table_grants
         WHERE  grantee = 'aida26_user'
           AND  table_schema = 'public'
           AND  table_name = $1
           AND  privilege_type IN ('INSERT','UPDATE','DELETE')`,
        [t]
      );
      assert.equal(
        r.rows.length,
        0,
        `Protected table '${t}' must not grant INSERT/UPDATE/DELETE to aida26_user; found: ${r.rows.map((x) => x.privilege_type).join(',')}`
      );
    }
  } finally {
    await pool.end();
  }
});

test('scheduler-schema: soft-delete consistency check constraints exist', async () => {
  await resetTestDb();
  const pool = makeTestPool();
  try {
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    const softDeleteTables: Array<[string, string]> = [
      ['public', 'clients'],
      ['public', 'professionals'],
      ['public', 'services'],
      ['public', 'resources'],
    ];

    for (const [schema, table] of softDeleteTables) {
      assert.equal(
        await checkConstraintExists(pool, schema, table, 'deleted_at'),
        true,
        `${schema}.${table} must have a check constraint involving deleted_at`
      );
    }
  } finally {
    await pool.end();
  }
});

test('scheduler-schema: appointments has valid status check constraint', async () => {
  await resetTestDb();
  const pool = makeTestPool();
  try {
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    assert.equal(
      await checkConstraintExists(pool, 'public', 'appointments', 'requested'),
      true,
      "appointments must have a state check constraint including 'requested'"
    );
    assert.equal(
      await checkConstraintExists(pool, 'public', 'appointments', 'no_show'),
      true,
      "appointments state check constraint must include 'no_show'"
    );

    // Single nullable resource_id (no appointment_resources join table).
    assert.equal(await fkExists(pool, 'public', 'appointments', 'client_id'),       true, 'appointments.client_id FK must exist');
    assert.equal(await fkExists(pool, 'public', 'appointments', 'professional_id'), true, 'appointments.professional_id FK must exist');
    assert.equal(await fkExists(pool, 'public', 'appointments', 'service_id'),      true, 'appointments.service_id FK must exist');
    assert.equal(await fkExists(pool, 'public', 'appointments', 'resource_id'),     true, 'appointments.resource_id FK must exist');

    assert.equal(await columnExists(pool, 'public', 'appointments', 'starts_at'),        true, 'appointments must have starts_at');
    assert.equal(await columnExists(pool, 'public', 'appointments', 'duration_minutes'), true, 'appointments must have duration_minutes');
    assert.equal(await columnExists(pool, 'public', 'appointments', 'ends_at'),          true, 'appointments must have generated ends_at');
    assert.equal(await columnExists(pool, 'public', 'appointments', 'price'),            true, 'appointments must have price');
  } finally {
    await pool.end();
  }
});

test('scheduler-schema: second migration run is idempotent (no re-application)', async () => {
  await resetTestDb();
  const pool = makeTestPool();
  try {
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
    const secondRun = await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
    assert.equal(secondRun, 0, 'Second migration run must apply 0 files (idempotent)');
  } finally {
    await pool.end();
  }
});
