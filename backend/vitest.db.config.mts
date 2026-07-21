import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // A test file that needs real Postgres is named *.db.test.ts (see vitest.config.mts) — an
    // explicit, self-evident split instead of two hand-maintained include lists that can drift.
    include: ['test/**/*.db.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    // DROP DATABASE blocks while other backends hold the database rather than failing fast, so a
    // reset behind a competing run waits seconds before it can proceed. The default 10s left no
    // room for that wait plus the migrations that share the same hook.
    hookTimeout: 30_000,
    // Drops the run's database (TEST_DB_NAME, default professional_agenda_test) once every file
    // has finished, so a uniquely-named concurrent run doesn't leave an orphan behind.
    globalSetup: ['./test/global-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage-db',
      include: ['src/**/*.ts', '../shared/src/**/*.ts'],
      exclude: ['src/server.ts', 'src/migrate.ts', 'src/seed-*.ts'],
      // This suite exercises routes/db/services through real HTTP + Postgres; the pure suite's
      // own coverage.config covers what runs without a DB.
      //
      // A full 31-file --coverage run's report never finishes writing in this sandbox (the test
      // run itself completes and prints its summary, but the v8 report/merge step hangs with no
      // error — reproducible with fileParallelism:false).
      // Measured instead on a clean 15/31-file majority subset (2026-07-20, all passing):
      // statements 79.25%, branches 67.8%, functions 87.53%, lines 82.76%. Coverage is monotonic
      // in the number of exercised files, so the full suite's true numbers can only be >= these —
      // thresholds set just under them are a safe floor, not a guess. Re-measure with
      // `npm run test:db:coverage` somewhere the full run's report completes and tighten further.
      thresholds: {
        lines: 80,
        statements: 78,
        functions: 85,
        branches: 65,
      },
    },
  },
});
