/**
 * Type-checks the specs together with the app (tsconfig.tests.json) and holds
 * the error count to the recorded ceiling in scripts/typecheck-tests-ceiling.json:
 * a count above it fails, a count below it asks for the ceiling to be lowered.
 * At a ceiling of 0 this is a plain type-check gate.
 *
 * Usage: yarn typecheck:tests [--update]   (--update records a lower count)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CEILING_FILE = 'scripts/typecheck-tests-ceiling.json';
const run = spawnSync('yarn', ['vue-tsc', '--noEmit', '-p', 'tsconfig.tests.json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const output = `${run.stdout}${run.stderr}`;
const errors = output.split('\n').filter((line) => /error TS\d+:/.test(line));
const { ceiling } = JSON.parse(readFileSync(CEILING_FILE, 'utf8'));

if (errors.length > ceiling) {
  process.stdout.write(output);
  console.error(`spec type errors rose: ${errors.length} > ceiling ${ceiling}`);
  process.exit(1);
}
if (errors.length < ceiling) {
  if (process.argv.includes('--update')) {
    writeFileSync(CEILING_FILE, `${JSON.stringify({ ceiling: errors.length }, null, 2)}\n`);
    console.info(`ceiling lowered: ${ceiling} -> ${errors.length}`);
  } else {
    console.error(
      `spec type errors fell to ${errors.length}; run with --update to lower the ceiling from ${ceiling}`,
    );
    process.exit(1);
  }
} else {
  console.info(`spec type errors: ${errors.length} (ceiling ${ceiling})`);
}
