import { fileURLToPath } from 'url';
import { resolve } from 'path';
import { defineConfig } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const isCI = process.env.CI === 'true';

// e2e/ has its own package.json (see the .mts note below), so Playwright's default report
// location resolves against *this* directory, not frontend/. Pin it explicitly to frontend/
// so it lands where .github/workflows/ci.yml uploads it from.
const reportDir = resolve(__dirname, '..', 'playwright-report');

// .mts (explicit ESM) so this config loads via import() even though the e2e/ directory is pinned to
// commonjs (e2e/package.json) — which is what lets the spec files use named imports from the CJS
// shared/ modules. Config = ESM, specs = CJS, same folder.

// In CI the build/migrate/seed/start steps run as explicit job steps before the test
// run, so reuseExistingServer=true lets Playwright skip the webServer entirely.
const reuseServer = isCI || process.env.E2E_REUSE_SERVER === 'true';

export default defineConfig({
  testDir: __dirname,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Serial by default: every spec runs against one shared seeded dataset and specs mutate the same
  // demo entities (a client's ledger, a professional's slots, business settings), so running files
  // concurrently makes a different spec fail each run. Set E2E_WORKERS to parallelise anyway.
  workers: Number(process.env.E2E_WORKERS ?? 1),
  fullyParallel: false,
  // CI-only: a flaky interleave gets one automatic re-run before it's reported as a real failure.
  // Local runs stay retry-free so a genuine bug fails immediately instead of masking on rerun.
  retries: isCI ? 2 : 0,
  reporter: [
    ['list'],
    // HTML report is what ci.yml uploads as an artifact on failure; open:'never' so it doesn't
    // try to launch a browser on the CI runner.
    ['html', { outputFolder: reportDir, open: 'never' }],
  ],
  use: {
    baseURL,
    headless: process.env.E2E_HEADLESS === '0' ? false : true,
    viewport: { width: 1280, height: 900 },
    // Only capture a trace for a test that's about to be retried — free on the happy path, and
    // gives a debuggable timeline exactly for the runs that need one (paired with retries above).
    trace: 'on-first-retry',
  },

  webServer: reuseServer
    ? undefined
    : {
        // Uses the test DB env vars (DB_PORT=5544) loaded from backend/.env.
        command: [
          'npm run build --prefix frontend',
          'npm run build --prefix backend',
          'npm run migrate --prefix backend',
          'npm run seed:demo --prefix backend',
          'node backend/dist/server.js',
        ].join(' && '),
        url: 'http://localhost:3000/health',
        reuseExistingServer: true,
        timeout: 120_000,
        env: {
          NODE_ENV: 'test',
          PORT: '3000',
        },
      },
});
