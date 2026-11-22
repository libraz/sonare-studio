/**
 * E2E smoke test for the studio shell.
 *
 * Drives a headless Chrome against a running dev server through the scenarios
 * in `scripts/e2e/scenarios.mjs` — the piano roll, the score, shortcuts and
 * layouts, OPFS persistence, audio import and recording, the mixer, device
 * rack, step sequencer, automation, cycle recording, routing, warp, freeze,
 * mastering, and the audio/MIDI/DAWproject exports. Each scenario lives in its
 * own module under `scripts/e2e/scenarios/`.
 *
 * Scenarios share one page and run in order, so each builds on what the last
 * one left behind. A scenario that throws is reported and the run continues,
 * and the summary at the end says which ones passed.
 *
 * Playwright is the project's own dev dependency. By default the bundled
 * Playwright Chromium is used; set SONARE_E2E_BROWSER_CHANNEL=chrome to force
 * the local Chrome channel, or SONARE_E2E_BROWSER_EXECUTABLE=/path/to/browser
 * to use a specific binary. Set SONARE_E2E_HEADLESS=0 to debug with a visible
 * browser.
 *
 * Usage:
 *   yarn dev --port 5199   # in the project root, in the background
 *   node scripts/e2e-smoke.mjs [baseUrl]
 *   node scripts/e2e-smoke.mjs --list
 *   node scripts/e2e-smoke.mjs --through=audio-record
 *   node scripts/e2e-smoke.mjs --only=boot,piano-roll,score
 *
 * An unknown flag, scenario or extra positional argument is refused.
 *
 * `--only` runs exactly the named scenarios and `--through` runs everything up
 * to and including one, which is how a single scenario is iterated on without
 * paying for the whole run. Both keep the registry's order. Nothing replays a
 * scenario's prerequisites for you: a scenario dropped from the run is state
 * the later ones will not find.
 */
import { parseRunnerArgs } from './e2e/args.mjs';
import { reportOutcomes, runScenarios } from './e2e/harness.mjs';
import { scenarios } from './e2e/scenarios.mjs';

const parsed = parseRunnerArgs(
  process.argv.slice(2),
  scenarios.map((scenario) => scenario.name),
);
const baseUrl = parsed.baseUrl ?? 'http://localhost:5199';

if (parsed.list) {
  for (const scenario of scenarios) console.info(scenario.name);
  process.exit(0);
}

const chosen = scenarios.filter((scenario) => parsed.selected.includes(scenario.name));
console.info(`running ${chosen.length}/${scenarios.length} scenario(s) against ${baseUrl}\n`);
const { outcomes } = await runScenarios(chosen, baseUrl);
process.exitCode = reportOutcomes(outcomes);
