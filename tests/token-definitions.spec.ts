import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards against referencing a CSS custom property that is defined nowhere.
 *
 * A `var(--token)` with NO fallback silently collapses to an invalid value when
 * the token is undefined — a border vanishes, a radius becomes 0 — and nothing
 * fails loudly. This test scans every stylesheet and single-file-component for
 * fallback-less `var(--x)` references and asserts each one resolves to a
 * definition somewhere in the source tree (a global token, a controls/base
 * utility, a component-local custom property, or one set from JS/template).
 *
 * `var(--x, fallback)` references are intentionally allowed: the fallback makes
 * an undefined token harmless, so they are skipped.
 */

const SRC = resolve(process.cwd(), 'src');

/** Recursively collects files under `dir` whose extension is in `exts`. */
function collectFiles(dir: string, exts: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full, exts));
    else if (exts.has(extname(entry.name))) out.push(full);
  }
  return out;
}

const FILES = collectFiles(SRC, new Set(['.css', '.vue', '.ts']));

/** Custom properties defined anywhere: `--x:` declarations and JS/template sets. */
const defined = new Set<string>();
/** Fallback-less `var(--x)` references, mapped to the files that use them. */
const referenced = new Map<string, Set<string>>();

const DEFINE_RE = /(?:^|[\s;{])(--[a-z0-9-]+)\s*:/gi;
const JS_SET_RE = /(?:setProperty\(\s*|["'])(--[a-z0-9-]+)["']\s*(?:,|:)/gi;
const VAR_RE = /var\(\s*(--[a-z0-9-]+)\s*([,)])/gi;

for (const file of FILES) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(SRC, file);
  for (const m of text.matchAll(DEFINE_RE)) defined.add(m[1]);
  for (const m of text.matchAll(JS_SET_RE)) defined.add(m[1]);
  for (const m of text.matchAll(VAR_RE)) {
    if (m[2] === ')') {
      // No fallback present — the token must be defined somewhere.
      const users = referenced.get(m[1]) ?? new Set<string>();
      users.add(rel);
      referenced.set(m[1], users);
    }
  }
}

describe('design tokens', () => {
  it('defines every fallback-less var(--token) referenced in the source', () => {
    const missing: string[] = [];
    for (const [token, users] of referenced) {
      if (!defined.has(token)) {
        missing.push(`${token}  (used in: ${[...users].sort().join(', ')})`);
      }
    }
    expect(missing, `Undefined CSS custom properties:\n${missing.join('\n')}`).toEqual([]);
  });
});
