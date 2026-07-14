// Fresh e2e run against a BUILT server (not the vite hot-reload dev stack): faster and stable —
// hot-reload reloads/re-optimizes mid-test cause flaky failures. Steps:
//   1. zero + reseed the demo DB inside the backend container (only it holds the DB_OWNER_* creds)
//   2. build the frontend (→ frontend/dist) and backend (→ backend/dist) from the working tree
//   3. serve the built app on :3100 (backend/dist/server.js serves frontend/dist + /api), non-prod
//      so the session cookie isn't Secure over http
//   4. run Playwright against it; 5. tear the server down
// Extra args are forwarded to `playwright test` as filters, e.g.
//   npm run test:e2e:fresh -- appointment-transitions
// Set E2E_REUSE_BUILT=1 to reuse an already-running :3100 server (skips build+serve) for fast
// spec iteration; the DB is still reset each run.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url)); // frontend/e2e
const repoRoot = resolve(here, '..', '..');
const frontendDir = resolve(here, '..');
const backendDir = resolve(repoRoot, 'backend');
const PORT = process.env.E2E_PORT ?? '3100';
const baseURL = `http://localhost:${PORT}`;

function run(cmd, args, opts) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...opts });
  if (r.status !== 0) {
    console.error(`\nCommand failed (exit ${r.status ?? 'signal'}): ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

async function healthy(url) {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthy(url)) return;
    await sleep(1000);
  }
  throw new Error(`Built server never became healthy at ${url}`);
}

// 1. Zero + reseed the demo DB.
run('docker', ['compose', 'exec', '-T', 'backend', 'npm', 'run', 'seed:demo:reset'], { cwd: repoRoot });

let server = null;
const reuse = process.env.E2E_REUSE_BUILT === '1' && (await healthy(`${baseURL}/health`));

if (reuse) {
  console.log(`\nReusing running built server at ${baseURL}`);
} else {
  // 2. Build the working tree.
  run('npm', ['run', 'build', '--prefix', 'frontend'], { cwd: repoRoot });
  run('npm', ['run', 'build', '--prefix', 'backend'], { cwd: repoRoot });

  // 3. Serve the built app (non-production so the session cookie isn't Secure over http).
  // tsc emits with rootDir '../', so the entry lands at dist/backend/src/server.js (server.js has a
  // fallback that still resolves frontend/dist for this nested layout).
  const serverEntry = 'dist/backend/src/server.js';
  console.log(`\n$ node ${serverEntry}  (PORT=${PORT}, cwd=backend)`);
  server = spawn('node', [serverEntry], {
    cwd: backendDir,
    env: { ...process.env, PORT, NODE_ENV: 'development' },
    stdio: 'inherit',
  });
  server.on('exit', (code) => {
    if (code && code !== 0) console.error(`Built server exited early (code ${code})`);
  });
}

try {
  await waitForHealth(`${baseURL}/health`, 90_000);

  // 4. Run Playwright against the built server.
  const pw = spawnSync(
    'npx',
    ['playwright', 'test', '-c', 'e2e/playwright.config.mts', ...process.argv.slice(2)],
    {
      cwd: frontendDir,
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, E2E_BASE_URL: baseURL, E2E_REUSE_SERVER: 'true' },
    },
  );
  process.exitCode = pw.status ?? 1;
} finally {
  // 5. Tear down (only the server we started).
  if (server) server.kill();
}
