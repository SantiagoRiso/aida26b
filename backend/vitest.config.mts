import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/auth.test.ts', 'test/ssot-domain.test.ts', 'test/schema-ssot-drift.test.ts', 'test/envelopes.test.ts', 'test/logging.test.ts', 'test/guard-route.test.ts', 'test/db-core.test.ts'],
    pool: 'forks',
    fileParallelism: false,
  },
});
