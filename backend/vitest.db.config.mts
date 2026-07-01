import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/migrate.test.ts', 'test/scheduler-schema.test.ts', 'test/api_tests.ts', 'test/generic-crud-policy.test.ts', 'test/health.test.ts', 'test/dev-seed.test.ts', 'test/auth-authz.test.ts', 'test/user-management.test.ts', 'test/calendar-grants.test.ts', 'test/conflict-check.test.ts', 'test/conflict-recheck.test.ts', 'test/set-schedule.test.ts', 'test/own-schedule-authz.test.ts', 'test/appointments-lifecycle.test.ts', 'test/ledger.test.ts', 'test/audit.test.ts'],
    pool: 'forks',
    fileParallelism: false,
  },
});
