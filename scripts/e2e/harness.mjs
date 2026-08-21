/**
 * Shared plumbing for the browser E2E scenarios: module resolution, the
 * browser launch, the WAV fixture builder, and the runner.
 *
 * Scenarios run in order against one page and build on each other's state —
 * the demo project, the imported asset, the tracks each one adds. What the
 * runner adds is containment: a scenario that throws is recorded and the rest
 * still run, so one broken step no longer hides everything behind it.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const projectRequire = createRequire(new URL('../../package.json', import.meta.url));

/** fflate's unzip, resolved from the project. */
export const { unzipSync } = projectRequire('fflate');

/**
 * Loads an optional dev dependency from wherever it happens to be installed.
 *
 * Both temp roots are tried because they differ: os.tmpdir() is the per-user
 * $TMPDIR (/var/folders/... on macOS), while "npm --prefix /tmp install" —
 * what the runner tells you to run — installs under the literal /tmp.
 */
export function loadModule(name) {
  const tempRoots = [...new Set([tmpdir(), '/tmp'])];
  const loaders = [
    ...tempRoots.map((root) => ({
      label: join(root, 'node_modules'),
      require: createRequire(join(root, 'sonare-e2e-loader.cjs')),
    })),
    { label: 'project node_modules', require: projectRequire },
    {
      label: 'current working directory',
      require: createRequire(join(process.cwd(), 'package.json')),
    },
  ];
  const errors = [];
  for (const loader of loaders) {
    try {
      return loader.require(name);
    } catch (error) {
      errors.push(`${loader.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `Unable to load ${name}. Install it with "npm --prefix /tmp install ${name}" ` +
      `or make it available in the project. Tried:\n${errors.join('\n')}`,
  );
}

/** Builds a mono 16-bit PCM WAV file containing a sine tone. */
export function makeWavBytes(seconds, frequencyHz, sampleRate = 44100, amplitude = 0.8) {
  const frames = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const sample = Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate) * amplitude;
    data.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Builds a sampler that reads a track's meter once the playhead is inside a
 * given PPQ window.
 *
 * An automation level only means what a scenario intends when it is read from
 * a known stretch of the pass, so every reading waits for the transport to be
 * there rather than sleeping and hoping.
 *
 * @param page The page under test.
 * @param trackId Track whose lane meter is read.
 * @returns `(minPpq, maxPpq) => Promise<number>` — the meter level in dB.
 */
export function laneMeterSampler(page, trackId) {
  return async (minPpq, maxPpq) => {
    await page.waitForFunction(
      ([lo, hi]) => {
        const ppq = window.__sonareDebug.positionPpq();
        return ppq >= lo && ppq < hi;
      },
      [minPpq, maxPpq],
      { timeout: 10000 },
    );
    return page.evaluate((id) => window.__sonareDebug.trackMeterDb(id), trackId);
  };
}

/** Launches the browser the scenarios drive. */
export async function launchBrowser() {
  const { chromium } = loadModule('playwright');
  const browserChannel = process.env.SONARE_E2E_BROWSER_CHANNEL;
  const executablePath = process.env.SONARE_E2E_BROWSER_EXECUTABLE;
  if (executablePath && !existsSync(executablePath)) {
    throw new Error(`SONARE_E2E_BROWSER_EXECUTABLE does not exist: ${executablePath}`);
  }
  try {
    return await chromium.launch({
      headless: process.env.SONARE_E2E_HEADLESS !== '0',
      ...(executablePath ? { executablePath } : browserChannel ? { channel: browserChannel } : {}),
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        // Fake microphone for the recording flow (tone generator, auto-granted).
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    });
  } catch (error) {
    throw new Error(
      `Unable to launch Chromium for E2E smoke. ` +
        `Try SONARE_E2E_BROWSER_CHANNEL=chrome or ` +
        `SONARE_E2E_BROWSER_EXECUTABLE=/path/to/chrome. ` +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Runs the given scenarios in order against one page.
 *
 * @param scenarios Scenario modules, in the order they must run.
 * @param baseUrl Origin the dev server is serving.
 * @returns Per-scenario outcomes and the total number of failures.
 */
export async function runScenarios(scenarios, baseUrl) {
  const browser = await launchBrowser();
  const outcomes = [];
  try {
    // The arrangement's persisted minimum height plus the editor dock needs a
    // tall viewport; Chromium's 720px default leaves the roll canvas clipped.
    // Fix the test viewport so visibility checks exercise the editor itself.
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
    page.on('pageerror', (err) => console.error('pageerror:', err.message));
    page.on('console', (message) => {
      if (message.type() === 'error') console.error('browser console:', message.text());
    });
    // Accept any incidental confirm() dialogs (e.g. the delete-project prompt).
    page.on('dialog', (dialog) => {
      void dialog.accept();
    });

    const ctx = { page, baseUrl, state: {}, fail: () => {} };
    for (const scenario of scenarios) {
      const failures = [];
      ctx.fail = (message) => {
        console.error(`FAIL [${scenario.name}]: ${message}`);
        failures.push(message);
      };
      const startedAt = process.hrtime.bigint();
      let thrown = null;
      try {
        await scenario.run(ctx);
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error);
        console.error(`FAIL [${scenario.name}]: ${thrown}`);
      }
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      outcomes.push({ name: scenario.name, failures, thrown, ms });
    }
    return { outcomes, failed: outcomes.filter((o) => o.failures.length > 0 || o.thrown).length };
  } finally {
    await browser.close();
  }
}

/** Prints the per-scenario summary and returns the process exit code. */
export function reportOutcomes(outcomes) {
  console.info('\n--- scenario summary ---');
  for (const outcome of outcomes) {
    const count = outcome.failures.length + (outcome.thrown ? 1 : 0);
    const mark = count === 0 ? 'PASS' : 'FAIL';
    console.info(
      `${mark} ${outcome.name.padEnd(24)} ${(outcome.ms / 1000).toFixed(1)}s` +
        (count === 0 ? '' : `  (${count} problem${count === 1 ? '' : 's'})`),
    );
  }
  const failed = outcomes.filter((o) => o.failures.length > 0 || o.thrown);
  console.info(`${outcomes.length - failed.length}/${outcomes.length} scenarios passed`);
  return failed.length === 0 ? 0 : 1;
}
