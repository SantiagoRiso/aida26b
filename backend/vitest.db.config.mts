import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/migrate.test.ts', 'test/scheduler-schema.test.ts', 'test/api_tests.ts', 'test/generic-crud-policy.test.ts', 'test/health.test.ts', 'test/dev-seed.test.ts', 'test/auth-authz.test.ts', 'test/user-management.test.ts', 'test/calendar-grants.test.ts'],
    pool: 'forks',
    fileParallelism: false,
  },
});
