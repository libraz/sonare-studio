import { readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CANVAS_FONT_SIZE_PX, CANVAS_FONT_STACK, canvasFont } from '@/ui/theme/tokens';
import { readSource, sourceWindow } from './helpers/source-text';

/**
 * The type scale has one source of truth, tokens.css, and two consumers that
 * cannot read it directly: stylesheets that could hardcode a px value instead
 * of a var, and canvas draw loops that must take a font shorthand string.
 * Both drift silently — a hardcoded 9px looks right until the scale moves —
 * so they are pinned mechanically here rather than by review.
 */

const SRC = resolve(process.cwd(), 'src');
const css = readSource('src/ui/theme/tokens.css');

/** Recursively collects source files under `src` with one of the extensions. */
function collectFiles(dir: string, exts: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full, exts));
    else if (exts.has(extname(entry.name))) out.push(full);
  }
  return out;
}

/** Reads a `--name: value;` declaration from the first (`:root`) block. */
function rootVar(name: string): string | null {
  const root = sourceWindow(css, ':root {', '}');
  const match = root.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  return match ? match[1].trim() : null;
}

/**
 * The brand wordmark carries its own display sizes in --font-display and is
 * deliberately outside the UI text scale (see the typography block in
 * tokens.css), so it is the one file allowed to name its own sizes.
 */
const RAW_SIZE_EXEMPT = ['components/shell/BrandMark.vue'];

/** A `font:` / `font-size:` declaration with a literal length outside var(). */
const FONT_DECLARATION = /^[ \t]*font(?:-size)?\s*:\s*([^;]+);/gm;
const LITERAL_LENGTH = /(?<![\w.-])[\d.]+(?:px|rem|em)(?![\w-])/;

describe('type scale', () => {
  it('leaves no stylesheet naming its own font size', () => {
    const offenders: string[] = [];

    for (const file of collectFiles(SRC, new Set(['.css', '.vue']))) {
      const rel = relative(SRC, file);
      if (RAW_SIZE_EXEMPT.includes(rel)) continue;
      const text = readSource(`src/${rel}`);
      for (const match of text.matchAll(FONT_DECLARATION)) {
        // A literal inside var(--x, 13px) is a fallback, not a chosen size.
        const outsideVars = match[1].replace(/var\([^)]*\)/g, '');
        if (LITERAL_LENGTH.test(outsideVars)) {
          offenders.push(`${rel}: ${match[0].trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('mirrors the canvas typeface and sizes from tokens.css', () => {
    // The stack is written on one line here and wrapped in the stylesheet.
    expect(rootVar('--font-sans')?.replace(/\s+/g, ' ')).toBe(CANVAS_FONT_STACK);
    expect(rootVar('--fs-chrome-md')).toBe(`${CANVAS_FONT_SIZE_PX.chromeMd}px`);
    expect(rootVar('--fs-2xs')).toBe(`${CANVAS_FONT_SIZE_PX.meta}px`);
    expect(rootVar('--fs-xs')).toBe(`${CANVAS_FONT_SIZE_PX.label}px`);
  });

  it('states which mirrored step the compact density moves out from under', () => {
    // A canvas draw loop never sees the density attribute. Only --fs-xs of the
    // three mirrored steps is overridden, and the mirror keeps the root value
    // on purpose; this pins that the other two stay density-invariant.
    const block = sourceWindow(css, ":root[data-density='compact']", '}');
    expect(block).toContain('--fs-xs:');
    expect(block).not.toContain('--fs-2xs:');
    expect(block).not.toContain('--fs-chrome-');
  });

  it('builds a canvas font shorthand from the shared stack', () => {
    expect(canvasFont(10)).toBe(`10px ${CANVAS_FONT_STACK}`);
    expect(canvasFont(10, 600)).toBe(`600 10px ${CANVAS_FONT_STACK}`);
  });

  it('leaves no canvas renderer naming its own typeface', () => {
    const offenders: string[] = [];

    for (const file of collectFiles(SRC, new Set(['.ts', '.vue']))) {
      const rel = relative(SRC, file);
      if (rel.startsWith('wasm/')) continue;
      const text = readSource(`src/${rel}`);
      for (const [index, line] of text.split('\n').entries()) {
        if (/\bctx\.font\s*=/.test(line) && !line.includes('canvasFont')) {
          offenders.push(`${rel}:${index + 1}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
