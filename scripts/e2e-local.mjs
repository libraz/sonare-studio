/**
 * Runs the E2E smoke against a production build of this tree.
 *
 * Builds the app once into `.e2e-dist/` with the debug surface the scenarios
 * drive (`VITE_SONARE_E2E=1`), serves it statically on a dedicated strict
 * port, runs `scripts/e2e-smoke.mjs` against it with any arguments passed
 * through, then stops the server. A static build cannot hot-reload, so an edit
 * made while the run is in flight cannot change what the run is testing, and a
 * stale or foreign server on the usual port cannot stand in for this tree.
 *
 * Usage:
 *   yarn e2e
 *   yarn e2e --through=realtime-mute
 *   SONARE_E2E_PORT=5300 yarn e2e
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

const port = Number(process.env.SONARE_E2E_PORT ?? 5299);
const baseUrl = `http://localhost:${port}`;
const READY_TIMEOUT_MS = 120_000;

const OUT_DIR = '.e2e-dist';
/** The preview server's stdout and stderr, kept whole for a server that dies mid-run. */
const SERVER_LOG = `${OUT_DIR}/preview-server.log`;

for (const args of [['build:worklet'], ['vite', 'build', '--outDir', OUT_DIR, '--emptyOutDir']]) {
  const step = spawnSync('yarn', args, {
    stdio: 'inherit',
    env: { ...process.env, VITE_SONARE_E2E: '1' },
  });
  if (step.status !== 0) process.exit(step.status ?? 1);
}

const server = spawn(
  'yarn',
  ['vite', 'preview', '--outDir', OUT_DIR, '--port', String(port), '--strictPort'],
  {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let serverLog = '';
writeFileSync(SERVER_LOG, '');
const keepLog = (chunk) => {
  serverLog += chunk;
  appendFileSync(SERVER_LOG, chunk);
};
server.stdout.on('data', keepLog);
server.stderr.on('data', keepLog);
let serverExited = false;
let stopping = false;
server.on('exit', (code, signal) => {
  serverExited = true;
  const line = `[preview server exited: code ${code}, signal ${signal}, at ${new Date().toISOString()}]\n`;
  appendFileSync(SERVER_LOG, line);
  if (!stopping) process.stderr.write(`${line}server output: ${SERVER_LOG}\n`);
});

function stopServer() {
  stopping = true;
  if (serverExited) return;
  try {
    // Negative pid: the whole group, so vite dies along with the yarn wrapper.
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}
process.on('exit', stopServer);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopServer();
    process.exit(130);
  });
}

async function waitForServer() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (serverExited) throw new Error(`preview server exited before serving:\n${serverLog}`);
    try {
      const res = await fetch(baseUrl);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`preview server did not serve ${baseUrl} within ${READY_TIMEOUT_MS} ms`);
}

await waitForServer();
const smoke = spawn(
  process.execPath,
  ['scripts/e2e-smoke.mjs', baseUrl, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
const code = await new Promise((resolve) => smoke.on('exit', (c) => resolve(c ?? 1)));
stopServer();
process.exit(code);
