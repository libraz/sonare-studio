/**
 * Runs the E2E smoke against a dev server of its own.
 *
 * Starts `yarn dev` on a dedicated strict port, waits until it serves, runs
 * `scripts/e2e-smoke.mjs` against it with any arguments passed through, then
 * stops the server. A fresh server per run keeps a stale or foreign server on
 * the usual port from standing in for this tree.
 *
 * Usage:
 *   yarn e2e
 *   yarn e2e --through=realtime-mute
 *   SONARE_E2E_PORT=5300 yarn e2e
 */
import { spawn } from 'node:child_process';

const port = Number(process.env.SONARE_E2E_PORT ?? 5299);
const baseUrl = `http://localhost:${port}`;
const READY_TIMEOUT_MS = 120_000;

const server = spawn('yarn', ['dev', '--port', String(port), '--strictPort'], {
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
const keepLog = (chunk) => {
  serverLog += chunk;
};
server.stdout.on('data', keepLog);
server.stderr.on('data', keepLog);
let serverExited = false;
server.on('exit', () => {
  serverExited = true;
});

function stopServer() {
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
    if (serverExited) throw new Error(`dev server exited before serving:\n${serverLog}`);
    try {
      const res = await fetch(baseUrl);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`dev server did not serve ${baseUrl} within ${READY_TIMEOUT_MS} ms`);
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
