/**
 * Key/scale bridge between the store's {@link ScaleHighlightConfig} and
 * libcantus's {@link KeyScale}.
 *
 * Both sides encode a scale as a root pitch class plus a 12-bit interval mask
 * where bit `n` marks the pitch class `(root + n) % 12` as in-scale (bit 0, the
 * root, always set). The conventions are identical — libcantus's `MAJOR_MASK`
 * equals the app's `MAJOR_MODE_MASK` (both 2741) — so the conversion is a plain
 * field rename. {@link assertMaskConventionParity} pins that equality so a
 * future drift on either side is caught by the adapter unit test rather than
 * silently mis-highlighting scales.
 *
 * Pure module (no Vue/Pinia); the store-reading helpers live in the callers.
 */

import { type KeyScale, MAJOR_MASK } from '@libraz/libcantus';
import { MAJOR_MODE_MASK, type ScaleHighlightConfig } from '@/project/types';

/** Default key used when the project has no key set: C major. */
export const DEFAULT_KEY_SCALE: KeyScale = { rootPc: 0, modeMask12: MAJOR_MODE_MASK };

/**
 * Converts a store scale-highlight config to a libcantus key/scale.
 *
 * The `enabled` flag is a UI concern and is dropped; callers decide whether to
 * treat a disabled highlight as "no key" (falling back to {@link DEFAULT_KEY_SCALE}).
 */
export function scaleHighlightToKeyScale(config: ScaleHighlightConfig): KeyScale {
  return { rootPc: ((config.rootPc % 12) + 12) % 12, modeMask12: config.modeMask };
}

/**
 * Converts a libcantus key/scale to a store scale-highlight config.
 *
 * @param key Key/scale to display.
 * @param enabled Whether highlighting should be active (default true).
 */
export function keyScaleToScaleHighlight(key: KeyScale, enabled = true): ScaleHighlightConfig {
  return { enabled, rootPc: ((key.rootPc % 12) + 12) % 12, modeMask: key.modeMask12 };
}

/**
 * Resolves the key context for theory queries: the highlighted scale when
 * highlighting is enabled, otherwise the C-major default. Callers surface the
 * "no key set" state separately (see the guidance/card fallbacks).
 */
export function effectiveKeyScale(config: ScaleHighlightConfig): KeyScale {
  return config.enabled ? scaleHighlightToKeyScale(config) : DEFAULT_KEY_SCALE;
}

/**
 * Major-key tonic pitch class for a key-signature fifths count (circle of
 * fifths): 0 = C, +1 = G, -1 = F, .... Used to give libcantus's spelling
 * functions a tonic derived from the score's `keyFifths`.
 */
export function tonicPcFromKeyFifths(keyFifths: number): number {
  return (((keyFifths * 7) % 12) + 12) % 12;
}

/**
 * Asserts that the app and libcantus agree on the major-scale interval mask.
 * Returns true on match; throws (in tests) when the two constants drift.
 */
export function assertMaskConventionParity(): boolean {
  if (MAJOR_MODE_MASK !== MAJOR_MASK) {
    throw new Error(
      `Scale-mask convention drift: MAJOR_MODE_MASK=${MAJOR_MODE_MASK} but libcantus MAJOR_MASK=${MAJOR_MASK}`,
    );
  }
  return true;
}
