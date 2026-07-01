import { describe, test, assert, expect } from 'vitest';
import { Pool } from 'pg';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migration-files';
import { runMigrations } from '../src/migrate';
import { resetTestDb, makeTestPool } from './helpers';

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

async function uniqueConstraintExists(
  pool: Pool,
  schema: string,
  table: string,
  constraintName: string
): Promise<boolean> {
  const r = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.table_constraints
       WHERE table_schema    = $1
         AND table_name      = $2
         AND constraint_name = $3
         AND constraint_type = 'UNIQUE'
     ) AS exists`,
    [schema, table, constraintName]
  );
  return r.rows[0].exists;
}

async function pkColumn(
  pool: Pool,
  schema: string,
  table: string
): Promise<string | null> {
  const r = await pool.query<{ column_name: string }>(
    `SELECT kcu.column_name
     FROM   information_schema.table_constraints tc
     JOIN   information_schema.key_column_usage  kcu
            ON  kcu.constraint_name  = tc.constraint_name
            AND kcu.constraint_schema = tc.constraint_schema
     WHERE  tc.table_schema    = $1
       AND  tc.table_name      = $2
       AND  tc.constraint_type = 'PRIMARY KEY'
     ORDER  BY kcu.ordinal_position`,
    [schema, table]
  );
  if (r.rows.length === 1) return r.rows[0].column_name;
  return null;
}

async function fkTarget(
  pool: Pool,
  fromSchema: string,
  fromTable: string,
  fromColumn: string
): Promise<{ toTable: string; toColumn: string } | null> {
  const r = await pool.query<{ to_table: string; to_column: string }>(
    `SELECT ccu.table_name  AS to_table,
            ccu.column_name AS to_column
     FROM   information_schema.key_column_usage         kcu
     JOIN   information_schema.referential_constraints  rc
            ON  rc.constraint_name   = kcu.constraint_name
            AND rc.constraint_schema = kcu.constraint_schema
     JOIN   information_schema.constraint_column_usage  ccu
            ON  ccu.constraint_name   = rc.unique_constraint_name
            AND ccu.constraint_schema = rc.unique_constraint_schema
     WHERE  kcu.table_schema = $1
       AND  kcu.table_name   = $2
       AND  kcu.column_name  = $3`,
    [fromSchema, fromTable, fromColumn]
  );
  if (!r.rows[0]) return null;
  return { toTable: r.rows[0].to_table, toColumn: r.rows[0].to_column };
}

test('scheduler-schema: applies all migrations to a fresh database without error', async () => {
  await resetTestDb();
  const pool = makeTestPool();
  try {
    const applied = await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
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

test('scheduler-schema: clients and professionals tables do not exist (centralized model)', async () => {
  await resetTestDb();
  const pool = makeTestPool();
  try {
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
    assert.equal(await tableExists(pool, 'public', 'clients'),       false, 'clients table must not exist after centralization');
    assert.equal(await tableExists(pool, 'public', 'professionals'), false, 'professionals table must not exist after centralization');
  } finally {
    await pool.end();
  }
});

test('scheduler-schema: auth.users has centralized person columns; no composite-FK unique key', async () => {
  await resetTestDb();
  const pool = makeTestPool();
  try {
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    assert.equal(await columnExists(pool, 'auth', 'users', 'display_name'), true,  'auth.users must have display_name');
    assert.equal(await columnExists(pool, 'auth', 'users', 'phone'),        true,  'auth.users must have phone');
    assert.equal(await columnExists(pool, 'auth', 'users', 'bio'),          true,  'auth.users must have bio');
    assert.equal(await columnExists(pool, 'auth', 'users', 'notes'),        true,  'auth.users must have notes');

    assert.equal(
      await uniqueConstraintExists(pool, 'auth', 'users', 'users_id_role_unique'),
      false,
      'auth.users must NOT have users_id_role_unique (composite-FK target removed)'
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

    const result = await pool.query<{ timezone: string; currency_code: string }>(
      `INSERT INTO businesses (name) VALUES ('Test Business') RETURNING timezone, currency_code`
    );
    assert.equal(result.rows[0].timezone,      'America/Argentina/Buenos_Aires', 'default timezone should be ARS zone');
    assert.equal(result.rows[0].currency_code.trim(), 'ARS', 'default currency_code should be ARS');

    await expect(
      pool.query(`INSERT INTO businesses (name, currency_code) VALUES ('Bad', 'USD')`)
    ).rejects.toThrow();
  } finally {
    await pool.end();
  }
});

test('scheduler-schema: direct-owner tables (resources, services, audit_events) have business_id; derived tables do not', async () => {
  await resetTestDb();
  const pool = makeTestPool();
  try {
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    const withBusinessId = [
      'resources',
      'services',
      'audit_events',
    ];

    for (const t of withBusinessId) {
      assert.equal(
        await columnExists(pool, 'public', t, 'business_id'),
        true,
        `Table '${t}' must have business_id column`
      );
    }

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

    const validRoles = ['Admin', 'Professional', 'Receptionist', 'Client'];
    for (const role of validRoles) {
      const r = await pool.query(
        `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role)
         VALUES ($1, $2, $3, 'hash', 'salt', $4) RETURNING id`,
        [`testuser_${role}`, `${role}@test.com`, `Test ${role}`, role]
      );
      assert.equal(r.rows.length, 1, `D1 role '${role}' should be accepted`);
    }

    await expect(
      pool.query(
        `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role)
         VALUES ('oldadmin', 'admin@old.com', 'Old Admin', 'hash', 'salt', 'admin')`
      )
    ).rejects.toThrow();
  } finally {
    await pool.end();
  }
});

test('scheduler-schema: FK constraints are valid — businesses and auth.users referenced correctly', async () => {
  await resetTestDb();
  const pool = makeTestPool();
  try {
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

    assert.equal(await fkExists(pool, 'public', 'resources', 'business_id'),    true, 'resources.business_id FK must exist');
    assert.equal(await fkExists(pool, 'public', 'services', 'business_id'),     true, 'services.business_id FK must exist');
    assert.equal(await fkExists(pool, 'public', 'audit_events', 'business_id'), true, 'audit_events.business_id FK must exist');
    assert.equal(await fkExists(pool, 'auth', 'users', 'business_id'),          true, 'auth.users.business_id FK must exist');

    assert.equal(await fkExists(pool, 'public', 'appointments', 'client_user_id'),                    true, 'appointments.client_user_id FK must exist');
    assert.equal(await fkExists(pool, 'public', 'appointments', 'professional_user_id'),              true, 'appointments.professional_user_id FK must exist');
    assert.equal(await fkExists(pool, 'public', 'calendar_grants', 'professional_user_id'),           true, 'calendar_grants.professional_user_id FK must exist');
    assert.equal(await fkExists(pool, 'public', 'schedules', 'professional_user_id'),                 true, 'schedules.professional_user_id FK must exist');
    assert.equal(await fkExists(pool, 'public', 'ledger_entries', 'client_user_id'),                  true, 'ledger_entries.client_user_id FK must exist');
    assert.equal(await fkExists(pool, 'public', 'client_professional_services', 'client_user_id'),    true, 'client_professional_services.client_user_id FK must exist');
    assert.equal(await fkExists(pool, 'public', 'client_professional_services', 'professional_user_id'), true, 'client_professional_services.professional_user_id FK must exist');
  } finally {
    await pool.end();
  }
});

test('scheduler-schema: protected tables have restricted grants for aida26_user', async () => {
  await resetTestDb();
  const pool = makeTestPool();
  try {
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);

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
      ['auth', 'users'],
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

    assert.equal(await fkExists(pool, 'public', 'appointments', 'client_user_id'),       true, 'appointments.client_user_id FK must exist');
    assert.equal(await fkExists(pool, 'public', 'appointments', 'professional_user_id'), true, 'appointments.professional_user_id FK must exist');
    assert.equal(await fkExists(pool, 'public', 'appointments', 'service_id'),           true, 'appointments.service_id FK must exist');
    assert.equal(await fkExists(pool, 'public', 'appointments', 'resource_id'),          true, 'appointments.resource_id FK must exist');

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

describe('scheduler-schema: centralized person model — plain FKs, no generated role columns', () => {
  let pool: Pool;

  async function setup() {
    await resetTestDb();
    pool = makeTestPool();
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
  }

  async function teardown() {
    await pool.end();
  }

  test('clients and professionals tables are absent', async () => {
    await setup();
    try {
      assert.equal(await tableExists(pool, 'public', 'clients'),       false, 'clients must not exist');
      assert.equal(await tableExists(pool, 'public', 'professionals'), false, 'professionals must not exist');
    } finally {
      await teardown();
    }
  });

  test('auth.users has display_name (NOT NULL), phone, bio, notes', async () => {
    await setup();
    try {
      assert.equal(await columnExists(pool, 'auth', 'users', 'display_name'), true, 'display_name must exist');
      assert.equal(await columnExists(pool, 'auth', 'users', 'phone'),        true, 'phone must exist');
      assert.equal(await columnExists(pool, 'auth', 'users', 'bio'),          true, 'bio must exist');
      assert.equal(await columnExists(pool, 'auth', 'users', 'notes'),        true, 'notes must exist');

      const r = await pool.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'display_name'`
      );
      assert.equal(r.rows[0]?.is_nullable, 'NO', 'display_name must be NOT NULL');

      await expect(
        pool.query(
          `INSERT INTO auth.users (username, email, password_hash, password_salt, role)
           VALUES ('no_display', 'nodisplay@test.com', 'hash', 'salt', 'Admin')`
        )
      ).rejects.toThrow();
    } finally {
      await teardown();
    }
  });

  test('users_id_role_unique constraint does NOT exist (composite-FK target removed)', async () => {
    await setup();
    try {
      assert.equal(
        await uniqueConstraintExists(pool, 'auth', 'users', 'users_id_role_unique'),
        false,
        'users_id_role_unique must not exist — it was the composite-FK target and has been removed'
      );
    } finally {
      await teardown();
    }
  });

  test('generated *_role columns do NOT exist on child tables', async () => {
    await setup();
    try {
      assert.equal(await columnExists(pool, 'public', 'appointments',               'client_role'),       false, 'appointments must not have client_role column');
      assert.equal(await columnExists(pool, 'public', 'appointments',               'professional_role'), false, 'appointments must not have professional_role column');
      assert.equal(await columnExists(pool, 'public', 'schedules',                  'professional_role'), false, 'schedules must not have professional_role column');
      assert.equal(await columnExists(pool, 'public', 'schedule_exceptions',        'professional_role'), false, 'schedule_exceptions must not have professional_role column');
      assert.equal(await columnExists(pool, 'public', 'client_professional_services', 'client_role'),     false, 'client_professional_services must not have client_role column');
      assert.equal(await columnExists(pool, 'public', 'client_professional_services', 'professional_role'), false, 'client_professional_services must not have professional_role column');
      assert.equal(await columnExists(pool, 'public', 'ledger_entries',             'client_role'),       false, 'ledger_entries must not have client_role column');
      assert.equal(await columnExists(pool, 'public', 'calendar_grants',            'professional_role'), false, 'calendar_grants must not have professional_role column');
    } finally {
      await teardown();
    }
  });

  test('child *_user_id columns have plain FKs to auth.users(id)', async () => {
    await setup();
    try {
      const checks: Array<[string, string, string]> = [
        ['appointments',                 'client_user_id',        'users'],
        ['appointments',                 'professional_user_id',  'users'],
        ['schedules',                    'professional_user_id',  'users'],
        ['schedule_exceptions',          'professional_user_id',  'users'],
        ['client_professional_services', 'client_user_id',        'users'],
        ['client_professional_services', 'professional_user_id',  'users'],
        ['ledger_entries',               'client_user_id',        'users'],
        ['calendar_grants',              'professional_user_id',  'users'],
      ];

      for (const [table, column, expectedTarget] of checks) {
        const target = await fkTarget(pool, 'public', table, column);
        assert.ok(target, `${table}.${column} must have a resolvable FK target`);
        assert.equal(target!.toTable, expectedTarget, `${table}.${column} must reference ${expectedTarget}`);
        assert.equal(target!.toColumn, 'id', `${table}.${column} must reference the PK column 'id', not a composite`);
      }
    } finally {
      await teardown();
    }
  });

  test('DB rejects wrong-role user in professional_user_id via trigger (defense in depth)', async () => {
    await setup();
    try {
      const clientUser = await pool.query<{ id: string }>(
        `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role)
         VALUES ('pk_client', 'pkclient@test.com', 'PK Client', 'hash', 'salt', 'Client')
         RETURNING id`
      );
      const clientId = clientUser.rows[0].id;

      await expect(
        pool.query(
          `INSERT INTO schedules (professional_user_id, weekly) VALUES ($1, '{}')`,
          [clientId]
        )
      ).rejects.toThrow();
    } finally {
      await teardown();
    }
  });

  test('calendar_grants.grantee_user_id is a plain FK to auth.users (no role constraint)', async () => {
    await setup();
    try {
      assert.equal(
        await fkExists(pool, 'public', 'calendar_grants', 'grantee_user_id'),
        true,
        'calendar_grants.grantee_user_id must be a FK'
      );
      const target = await fkTarget(pool, 'public', 'calendar_grants', 'grantee_user_id');
      assert.ok(target, 'grantee_user_id FK target must be resolvable');
      assert.equal(target!.toTable, 'users', 'grantee_user_id must reference users (auth.users)');
      assert.equal(target!.toColumn, 'id',   'grantee_user_id must reference the PK id, not a composite');
    } finally {
      await teardown();
    }
  });

  test('child FK columns still exist; old profile-table column names are absent', async () => {
    await setup();
    try {
      assert.equal(await columnExists(pool, 'public', 'appointments',               'client_user_id'),        true,  'appointments must have client_user_id');
      assert.equal(await columnExists(pool, 'public', 'appointments',               'professional_user_id'),  true,  'appointments must have professional_user_id');
      assert.equal(await columnExists(pool, 'public', 'schedules',                  'professional_user_id'),  true,  'schedules must have professional_user_id');
      assert.equal(await columnExists(pool, 'public', 'schedule_exceptions',        'professional_user_id'),  true,  'schedule_exceptions must have professional_user_id');
      assert.equal(await columnExists(pool, 'public', 'client_professional_services', 'client_user_id'),      true,  'client_professional_services must have client_user_id');
      assert.equal(await columnExists(pool, 'public', 'client_professional_services', 'professional_user_id'), true, 'client_professional_services must have professional_user_id');
      assert.equal(await columnExists(pool, 'public', 'ledger_entries',             'client_user_id'),        true,  'ledger_entries must have client_user_id');
      assert.equal(await columnExists(pool, 'public', 'calendar_grants',            'professional_user_id'),  true,  'calendar_grants must have professional_user_id');

      assert.equal(await columnExists(pool, 'public', 'appointments',               'client_id'),          false, 'appointments must not have old client_id column');
      assert.equal(await columnExists(pool, 'public', 'appointments',               'professional_id'),    false, 'appointments must not have old professional_id column');
      assert.equal(await columnExists(pool, 'public', 'schedules',                  'professional_id'),    false, 'schedules must not have old professional_id column');
      assert.equal(await columnExists(pool, 'public', 'schedule_exceptions',        'professional_id'),    false, 'schedule_exceptions must not have old professional_id column');
      assert.equal(await columnExists(pool, 'public', 'client_professional_services', 'client_id'),        false, 'client_professional_services must not have old client_id column');
      assert.equal(await columnExists(pool, 'public', 'client_professional_services', 'professional_id'),  false, 'client_professional_services must not have old professional_id column');
      assert.equal(await columnExists(pool, 'public', 'ledger_entries',             'client_id'),          false, 'ledger_entries must not have old client_id column');
      assert.equal(await columnExists(pool, 'public', 'calendar_grants',            'professional_id'),    false, 'calendar_grants must not have old professional_id column');
    } finally {
      await teardown();
    }
  });

  test('auth.users.business_id still exists as the single authoritative business per person', async () => {
    await setup();
    try {
      assert.equal(
        await columnExists(pool, 'auth', 'users', 'business_id'),
        true,
        'auth.users.business_id must exist (single authoritative business per person)'
      );
      assert.equal(
        await fkExists(pool, 'auth', 'users', 'business_id'),
        true,
        'auth.users.business_id must be a FK to businesses'
      );
    } finally {
      await teardown();
    }
  });

  test('DB trigger: schedules.professional_user_id rejects a non-Professional', async () => {
    await setup();
    try {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role)
         VALUES ('trg_client1', 'trgcli1@test.com', 'Trigger Client 1', 'h', 's', 'Client')
         RETURNING id`
      );
      const clientId = r.rows[0].id;

      await expect(
        pool.query(`INSERT INTO schedules (professional_user_id, weekly) VALUES ($1, '{}')`, [clientId])
      ).rejects.toThrow();

      const p = await pool.query<{ id: string }>(
        `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role)
         VALUES ('trg_pro1', 'trgpro1@test.com', 'Trigger Pro 1', 'h', 's', 'Professional')
         RETURNING id`
      );
      const proId = p.rows[0].id;
      const ok = await pool.query(
        `INSERT INTO schedules (professional_user_id, weekly) VALUES ($1, '{}') RETURNING id`,
        [proId]
      );
      assert.equal(ok.rows.length, 1, 'Professional user must be accepted in schedules.professional_user_id');
    } finally {
      await teardown();
    }
  });

  test('DB trigger: client_professional_services rejects wrong roles on both FK columns', async () => {
    await setup();
    try {
      const c = await pool.query<{ id: string }>(
        `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role)
         VALUES ('trg_client2', 'trgcli2@test.com', 'Trigger Client 2', 'h', 's', 'Client') RETURNING id`
      );
      const p = await pool.query<{ id: string }>(
        `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role)
         VALUES ('trg_pro2', 'trgpro2@test.com', 'Trigger Pro 2', 'h', 's', 'Professional') RETURNING id`
      );
      const svc = await pool.query<{ id: string }>(
        `INSERT INTO businesses (name) VALUES ('TriggerBiz') RETURNING id`
      ).then(async (biz) => pool.query<{ id: string }>(
        `INSERT INTO services (business_id, name, default_duration_minutes, default_price_ars)
         VALUES ($1, 'TriggerSvc', 30, 0) RETURNING id`,
        [biz.rows[0].id]
      ));
      const clientId = c.rows[0].id;
      const proId = p.rows[0].id;
      const svcId = svc.rows[0].id;

      await expect(
        pool.query(
          `INSERT INTO client_professional_services (client_user_id, professional_user_id, service_id, price_ars)
           VALUES ($1, $2, $3, 0)`,
          [proId, proId, svcId]
        )
      ).rejects.toThrow();

      await expect(
        pool.query(
          `INSERT INTO client_professional_services (client_user_id, professional_user_id, service_id, price_ars)
           VALUES ($1, $2, $3, 0)`,
          [clientId, clientId, svcId]
        )
      ).rejects.toThrow();

      const ok = await pool.query(
        `INSERT INTO client_professional_services (client_user_id, professional_user_id, service_id, price_ars)
         VALUES ($1, $2, $3, 0) RETURNING id`,
        [clientId, proId, svcId]
      );
      assert.equal(ok.rows.length, 1, 'Correct Client + Professional pair must be accepted');
    } finally {
      await teardown();
    }
  });

  test('DB trigger: calendar_grants.professional_user_id rejects a non-Professional', async () => {
    await setup();
    try {
      const c = await pool.query<{ id: string }>(
        `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role)
         VALUES ('trg_client3', 'trgcli3@test.com', 'Trigger Client 3', 'h', 's', 'Client') RETURNING id`
      );
      const p = await pool.query<{ id: string }>(
        `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role)
         VALUES ('trg_pro3', 'trgpro3@test.com', 'Trigger Pro 3', 'h', 's', 'Professional') RETURNING id`
      );
      const grantee = await pool.query<{ id: string }>(
        `INSERT INTO auth.users (username, email, display_name, password_hash, password_salt, role)
         VALUES ('trg_recep3', 'trgrecep3@test.com', 'Trigger Recep 3', 'h', 's', 'Receptionist') RETURNING id`
      );
      const clientId = c.rows[0].id;
      const proId = p.rows[0].id;
      const granteeId = grantee.rows[0].id;

      await expect(
        pool.query(
          `INSERT INTO calendar_grants (professional_user_id, grantee_user_id) VALUES ($1, $2)`,
          [clientId, granteeId]
        )
      ).rejects.toThrow();

      const ok = await pool.query(
        `INSERT INTO calendar_grants (professional_user_id, grantee_user_id) VALUES ($1, $2) RETURNING id`,
        [proId, granteeId]
      );
      assert.equal(ok.rows.length, 1, 'Professional must be accepted in calendar_grants.professional_user_id');
    } finally {
      await teardown();
    }
  });
});
