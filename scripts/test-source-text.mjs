/**
 * Runs the specs that assert on source text: every spec importing
 * tests/helpers/source-text. Fails when none is found, so the list cannot go
 * empty unnoticed. Run it after moving or renaming a source file.
 *
 * Usage: yarn test:source-text
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TESTS = 'tests';
const IMPORT = /from\s+['"]\.\/helpers\/source-text['"]/;

const specs = readdirSync(TESTS)
  .filter((name) => name.endsWith('.spec.ts'))
  .map((name) => join(TESTS, name))
  .filter((file) => IMPORT.test(readFileSync(file, 'utf8')))
  .sort();

if (specs.length === 0) {
  console.error('no source-text specs found (none imports tests/helpers/source-text)');
  process.exit(1);
}
console.info(`source-text specs: ${specs.length}`);
const run = spawnSync('yarn', ['vitest', 'run', ...specs], { stdio: 'inherit' });
process.exit(run.status ?? 1);
