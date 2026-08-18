import type { ChordQuality } from '@libraz/libcantus';
import { libcantusQualityToEditor, QUALITY_SUFFIX } from '@/compose/chord-quality';
import type { EditorChordSymbol } from '@/project/chords';

/**
 * Fixtures bridging the libcantus quality union to editor chord symbols, shared
 * by the tests that pin chord naming and the chord-track quality picker.
 */

/** Every quality libcantus can hand the app, in the naming table's order. */
export const LIBCANTUS_QUALITIES = Object.keys(QUALITY_SUFFIX) as ChordQuality[];

/**
 * The editor chord symbol a libcantus quality maps to, rooted on C. Extensions
 * and omissions are passed through exactly as the bridge emits them (unsorted
 * for some qualities), so callers see the chord as it arrives rather than as
 * the chord track would store it.
 *
 * @param quality libcantus chord quality.
 * @param startPpq Start of the one-bar region the symbol occupies.
 */
export function editorSymbolForQuality(quality: ChordQuality, startPpq = 0): EditorChordSymbol {
  const mapped = libcantusQualityToEditor(quality);
  return {
    startPpq,
    endPpq: startPpq + 4,
    rootPc: 0,
    quality: mapped.quality,
    ...(mapped.extensions === undefined ? {} : { extensions: [...mapped.extensions] }),
    ...(mapped.omissions === undefined ? {} : { omissions: [...mapped.omissions] }),
  };
}
