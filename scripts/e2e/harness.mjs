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

const projectRequire = createRequire(new URL('../../package.json', import.meta.url));

/** fflate's unzip, resolved from the project. */
export const { unzipSync } = projectRequire('fflate');

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

/**
 * Waits for an action to finish, accepting the app's own confirm dialogs on
 * the way.
 *
 * An export lists what its format will drop in the in-app dialog rather than
 * a native confirm(), so the page's dialog handler never sees it. Each
 * accepted message is logged: it records what the run's state made the export
 * warn about.
 *
 * @param page The page under test.
 * @param isDone Resolves true once the action has finished.
 * @param timeoutMs Overall deadline.
 * @returns The accepted dialog messages, in order.
 */
export async function untilDoneAcceptingConfirms(page, isDone, timeoutMs) {
  const prompt = page.locator('.modal-card:has(.dialog-message)');
  const accepted = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDone()) return accepted;
    if (await prompt.isVisible()) {
      const message = ((await prompt.locator('.dialog-message').textContent()) ?? '').trim();
      console.info(`accepted app confirm: ${message.replace(/\s+/g, ' ')}`);
      accepted.push(message);
      // A destructive confirmation styles its confirm button as danger-action.
      await prompt.locator('button.primary, button.danger-action').click();
      // A queued follow-up dialog reuses the open modal, so wait for this
      // message to leave rather than for the modal to close.
      await page.waitForFunction(
        (previous) => document.querySelector('.dialog-message')?.textContent?.trim() !== previous,
        message,
        { timeout: 5000 },
      );
      continue;
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for the action to finish`);
}

/** Launches the browser the scenarios drive. */
export async function launchBrowser() {
  const { chromium } = projectRequire('playwright');
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
    // Every page reports the libsonare calls it makes to the scenario running now;
    // newPage goes through newContext, so the shared page is covered too.
    let reached = new Set();
    const sink = (_source, key) => {
      reached.add(key);
    };
    // The app syncs the engine on a debounce, and a rack opened just before
    // run() returns polls on the next frame, so a scenario's last calls can reach
    // libsonare late; the boundary waits for both and credits them to that scenario.
    const lateCallScenarios = [];
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...args) => {
      const context = await newContext(...args);
      await context.exposeBinding('__sonareApiSink', sink);
      return context;
    };
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
      reached = new Set();
      await page.evaluate(() => window.__sonareDebug?.resetApiCalls?.()).catch(() => undefined);
      const startedAt = process.hrtime.bigint();
      let thrown = null;
      try {
        await scenario.run(ctx);
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error);
        console.error(`FAIL [${scenario.name}]: ${thrown}`);
      }
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const beforeSettle = reached.size;
      await page
        .evaluate(() =>
          Promise.all([
            window.__sonareDebug?.whenEngineSyncIdle?.(),
            window.__sonareDebug?.whenInsertGainReductionPolled?.(),
          ]),
        )
        .catch(() => undefined);
      if (reached.size > beforeSettle) lateCallScenarios.push(scenario.name);
      outcomes.push({
        name: scenario.name,
        failures,
        thrown,
        ms,
        knownEngineDefect: scenario.knownEngineDefect ?? null,
        apiCalls: [...reached].sort(),
      });
    }
    console.info(
      `libsonare calls still pending when run() returned: ${lateCallScenarios.length} of ` +
        `${scenarios.length} scenario(s)${lateCallScenarios.length ? ` (${lateCallScenarios.join(', ')})` : ''}`,
    );
    return { outcomes, failed: outcomes.filter(countsAsFailed).length };
  } finally {
    await browser.close();
  }
}

const problemCount = (outcome) => outcome.failures.length + (outcome.thrown ? 1 : 0);

/**
 * A scenario exporting `knownEngineDefect` covers a feature an engine defect
 * currently breaks: its failure is reported as XFAIL and does not fail the
 * run, and once the engine is fixed it passes like any other scenario.
 */
const countsAsFailed = (outcome) => problemCount(outcome) > 0 && !outcome.knownEngineDefect;

/** Prints the per-scenario summary and returns the process exit code. */
export function reportOutcomes(outcomes) {
  console.info('\n--- scenario summary ---');
  for (const outcome of outcomes) {
    const count = problemCount(outcome);
    const mark = count === 0 ? 'PASS' : outcome.knownEngineDefect ? 'XFAIL' : 'FAIL';
    console.info(
      `${mark} ${outcome.name.padEnd(24)} ${(outcome.ms / 1000).toFixed(1)}s` +
        (count === 0 ? '' : `  (${count} problem${count === 1 ? '' : 's'})`) +
        (count > 0 && outcome.knownEngineDefect
          ? `  engine defect: ${outcome.knownEngineDefect}`
          : ''),
    );
    if (count === 0 && outcome.knownEngineDefect) {
      console.info(
        `  ${outcome.name} passes; the engine defect it tracks is fixed, drop knownEngineDefect`,
      );
    }
  }
  const failed = outcomes.filter(countsAsFailed);
  const expected = outcomes.filter((o) => problemCount(o) > 0 && o.knownEngineDefect);
  console.info(
    `${outcomes.length - failed.length - expected.length}/${outcomes.length} scenarios passed`,
  );
  console.info(
    `${expected.length} XFAIL (open engine defects)` +
      (expected.length > 0 ? `: ${expected.map((o) => o.name).join(', ')}` : ''),
  );
  return failed.length === 0 ? 0 : 1;
}
