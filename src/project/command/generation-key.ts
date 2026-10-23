/**
 * The key a generator writes in at an absolute position: the same resolution
 * guidance and the placement guide use (declared key overridden by `Key:`
 * markers), falling back to the declared key when no key is in effect there.
 */

import type { KeyScale } from '@libraz/libcantus';
import { effectiveKeyScale } from '@/compose/key';
import { buildKeyMap } from '@/compose/key-map';
import type { useProjectStore } from '../store';

/**
 * Resolves the generation key at an absolute PPQ position.
 *
 * @param store The project store (declared scale and markers).
 * @param absPpq Absolute timeline position the generated material starts at.
 */
export function generationKeyAt(
  store: ReturnType<typeof useProjectStore>,
  absPpq: number,
): KeyScale {
  return (
    buildKeyMap(store.scaleHighlight, store.markers).at(absPpq) ??
    effectiveKeyScale(store.scaleHighlight)
  );
}
