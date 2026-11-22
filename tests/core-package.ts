/**
 * Where specs find the installed libsonare package: its wasm bytes, its
 * declaration files and its WASM migration ledger. Everything resolves through
 * the package's own exports, so a spec reads exactly what the app bundles.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** Root of the installed package. */
export const CORE_PACKAGE_DIR = path.dirname(require.resolve('@libraz/libsonare/package.json'));

/** Directory holding the package's runtime files and declarations. */
export const CORE_DIST_DIR = path.join(CORE_PACKAGE_DIR, 'dist');

/** The engine binary the package exports as `@libraz/libsonare/wasm`. */
export function coreWasmBinary(): Buffer {
  return readFileSync(require.resolve('@libraz/libsonare/wasm'));
}

/** One ledger row: a name the 2.0 surface removed, renamed or reshaped. */
export interface LedgerEntry {
  kind: string;
  old: string;
  new?: string;
  removed?: string | boolean;
  changed?: string | boolean;
  to?: string;
  no_replacement?: boolean;
  domain: string;
  rule: string;
  entry?: string;
}

/** The WASM migration ledger the installed package ships as `@libraz/libsonare/migration.json`. */
export function coreMigrationLedger(): { entry: LedgerEntry[] } {
  let exported: string;
  try {
    exported = require.resolve('@libraz/libsonare/migration.json');
  } catch {
    throw new Error('The installed @libraz/libsonare does not export migration.json');
  }
  return JSON.parse(readFileSync(exported, 'utf8'));
}
