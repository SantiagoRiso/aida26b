import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/migrate.test.ts', 'test/scheduler-schema.test.ts', 'test/api_tests.ts'],
    pool: 'forks',
    fileParallelism: false,
  },
});
