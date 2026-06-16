import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOKENS } from '@/ui/theme/tokens';

/**
 * The canvas/SVG editors (piano roll, arrangement) read their DARK palette from
 * tokens.ts while the light shell chrome reads the top-level vars in tokens.css.
 * The dark editor palette is mirrored in tokens.css under the `--canvas-*`
 * namespace; this guards the JS literals against drifting from that mirror.
 * Meter and playhead colors are drawn over the dark canvas too, so they share
 * the un-namespaced `--meter-*` / `--playhead` vars.
 */

const css = readFileSync(resolve(process.cwd(), 'src/ui/theme/tokens.css'), 'utf8');

/** Maps each TOKENS key to its CSS custom-property name (canvas palette). */
const CSS_VAR_BY_TOKEN: Record<keyof typeof TOKENS, string> = {
  surface0: '--canvas-surface-0',
  surface1: '--canvas-surface-1',
  surface2: '--canvas-surface-2',
  surface3: '--canvas-surface-3',
  surface4: '--canvas-surface-4',
  surfaceInset: '--canvas-surface-inset',
  border: '--canvas-border',
  borderStrong: '--canvas-border-strong',
  text1: '--canvas-text-1',
  text2: '--canvas-text-2',
  text3: '--canvas-text-3',
  text4: '--canvas-text-4',
  accent: '--canvas-accent',
  accentStrong: '--canvas-accent-strong',
  danger: '--canvas-danger',
  dangerText: '--canvas-danger-text',
  dangerSurface: '--canvas-danger-surface',
  warning: '--canvas-warning',
  success: '--canvas-success',
  successStrong: '--canvas-success-strong',
  meterGreen: '--meter-green',
  meterYellow: '--meter-yellow',
  meterRed: '--meter-red',
  playhead: '--playhead',
};

/** Reads a single `--name: value;` declaration from the :root block. */
function readCssVar(name: string): string | null {
  const match = css.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  return match ? match[1].trim() : null;
}

describe('theme tokens', () => {
  it('keeps tokens.ts in sync with tokens.css', () => {
    for (const [token, cssVar] of Object.entries(CSS_VAR_BY_TOKEN)) {
      expect(readCssVar(cssVar), `${cssVar} missing in tokens.css`).toBe(
        TOKENS[token as keyof typeof TOKENS],
      );
    }
  });
});
