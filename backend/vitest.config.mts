import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Any *.test.ts under test/ except the *.db.test.ts suite (vitest.db.config.mts) — the two
    // suites split by filename suffix, not a hand-maintained list, so a new file is picked up
    // automatically instead of silently never running.
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.db.test.ts', '**/node_modules/**'],
    pool: 'forks',
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts', '../shared/src/**/*.ts'],
      exclude: ['src/server.ts', 'src/migrate.ts', 'src/seed-*.ts'],
      // This suite alone (no DB) never reaches routes/db/services — floor set to what it
      // actually exercises today; the db suite's own coverage.config covers the rest.
      // Measured 2026-07-20: statements 23.68%, branches 15.82%, functions 34.74%, lines 25.06%.
      thresholds: {
        lines: 24,
        statements: 23,
        functions: 34,
        branches: 15,
      },
    },
  },
});
