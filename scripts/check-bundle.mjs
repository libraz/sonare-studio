#!/usr/bin/env node
// Checks the built app in dist/: the core wasm ships exactly once, byte-equal
// to the installed package's, the core's migration ledger stays out, and the
// browser-scenario debug surface (enabled only by VITE_SONARE_E2E=1) is absent.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const DIST = path.resolve(import.meta.dirname, '..', 'dist');
/** Vite's hashed asset name for the core's `sonare.wasm`. */
const CORE_WASM_ASSET = /^sonare-[\w-]{8}\.wasm$/;
/** A field name every ledger row carries and no app code spells. */
const LEDGER_MARKER = 'no_replacement';
/** The window global the debug surface installs; only an E2E build may carry it. */
const DEBUG_SURFACE_MARKER = '__sonareDebug';

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const full = path.join(dir, item.name);
    return item.isDirectory() ? files(full) : [full];
  });
}

const built = files(DIST);
const failures = [];
const copies = built.filter((file) => CORE_WASM_ASSET.test(path.basename(file)));
const expected = sha256(require.resolve('@libraz/libsonare/wasm'));
if (copies.length !== 1) {
  failures.push(`the core wasm ships ${copies.length} times: ${copies.join(', ')}`);
} else {
  const actual = sha256(copies[0]);
  const shipped = path.relative(DIST, copies[0]);
  if (actual === expected) console.info(`${shipped} sha256 ${actual} matches the package`);
  else failures.push(`${shipped} sha256 ${actual} is not the package's ${expected}`);
}
for (const file of built) {
  if (!file.endsWith('.wasm') && readFileSync(file).includes(LEDGER_MARKER)) {
    failures.push(`${path.relative(DIST, file)} carries the migration ledger`);
  }
  if (file.endsWith('.js') && readFileSync(file).includes(DEBUG_SURFACE_MARKER)) {
    failures.push(`${path.relative(DIST, file)} carries the debug surface`);
  }
}
if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
