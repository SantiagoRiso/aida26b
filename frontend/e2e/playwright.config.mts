import { fileURLToPath } from 'url';
import { defineConfig } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const __dirname = fileURLToPath(new URL('.', import.meta.url));

// .mts (explicit ESM) so this config loads via import() even though the e2e/ directory is pinned to
// commonjs (e2e/package.json) — which is what lets the spec files use named imports from the CJS
// shared/ modules. Config = ESM, specs = CJS, same folder.

// In CI the build/migrate/seed/start steps run as explicit job steps before the test
// run, so reuseExistingServer=true lets Playwright skip the webServer entirely.
const reuseServer = process.env.CI === 'true' || process.env.E2E_REUSE_SERVER === 'true';

export default defineConfig({
  testDir: __dirname,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Serial by default: every spec runs against one shared seeded dataset and specs mutate the same
  // demo entities (a client's ledger, a professional's slots, business settings), so running files
  // concurrently makes a different spec fail each run. Set E2E_WORKERS to parallelise anyway.
  workers: Number(process.env.E2E_WORKERS ?? 1),
  fullyParallel: false,
  use: {
    baseURL,
    headless: process.env.E2E_HEADLESS === '0' ? false : true,
    viewport: { width: 1280, height: 900 },
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
