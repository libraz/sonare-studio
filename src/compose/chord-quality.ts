/**
 * Single source of truth for chord-quality identity and display naming.
 *
 * Three key spaces describe the same chord: the editor's audio-domain quality
 * ordinal (Major = 0) plus a free list of extension semitone offsets, the
 * `"ordinal:ext,ext"` combination key those two form, and libcantus's
 * {@link ChordQuality} string union. Only the libcantus union carries a display
 * suffix ({@link QUALITY_SUFFIX}); every editor-side name is resolved by
 * bridging the ordinal + extensions to a libcantus quality, so the score view,
 * the chord track and MusicXML `<kind text>` cannot disagree about a chord.
 *
 * Leaf module: it imports nothing but libcantus, so both the editor model
 * (src/project/chords.ts) and the libcantus interchange (src/compose/chord-io.ts)
 * can depend on it without a cycle.
 */

import type { ChordQuality } from '@libraz/libcantus';

/**
 * Chord-symbol suffix per libcantus quality. Exhaustive over the union so a
 * quality added upstream is a compile error rather than an unnamed chord.
 * Suffixes are ASCII throughout (`majb5`, `m7b5`, `7#11`); the display layer
 * does not substitute Unicode accidentals.
 */
export const QUALITY_SUFFIX: Readonly<Record<ChordQuality, string>> = {
  maj: '',
  min: 'm',
  dim: 'dim',
  aug: 'aug',
  maj7: 'maj7',
  min7: 'm7',
  dom7: '7',
  dim7: 'dim7',
  m7b5: 'm7b5',
  minMaj7: 'm(maj7)',
  minMaj9: 'm(maj9)',
  minMaj11: 'm(maj11)',
  minMaj13: 'm(maj13)',
  aug7: 'aug7',
  augMaj7: 'aug(maj7)',
  majb5: 'majb5',
  '6': '6',
  min6: 'm6',
  '6/9': '6/9',
  sus2: 'sus2',
  sus4: 'sus4',
  add9: 'add9',
  add11: 'add11',
  maj9: 'maj9',
  min9: 'm9',
  dom9: '9',
  '7b9': '7b9',
  '7#9': '7#9',
  '7#11': '7#11',
  '7b13': '7b13',
  '11': '11',
  '13': '13',
  '5': '5',
  '7sus4': '7sus4',
  '7b5': '7b5',
  '7alt': '7alt',
  '13b9': '13b9',
  maj13: 'maj13',
  'maj7#11': 'maj7#11',
  min11: 'm11',
  min13: 'm13',
  minAdd9: 'm(add9)',
  'min6/9': 'm6/9',
};

/** Intrinsic pitch classes for each editor quality, used to discard redundant extensions. */
export const TONE_PCS_BY_QUALITY: Readonly<Record<number, ReadonlyArray<number>>> = {
  0: [0, 4, 7],
  1: [0, 3, 7],
  2: [0, 3, 6],
  3: [0, 4, 8],
  4: [0, 4, 7, 10],
  5: [0, 4, 7, 11],
  6: [0, 3, 7, 10],
  7: [0, 2, 7],
  8: [0, 5, 7],
  10: [0, 2, 4, 7],
  11: [0, 2, 3, 7],
  12: [0, 3, 6, 9],
  13: [0, 3, 6, 10],
  14: [0, 2, 4, 7, 11],
  15: [0, 2, 4, 7, 10],
};

/** Reduces an integer semitone offset to pitch-class space. */
function extensionPitchClass(value: number): number {
  return ((value % 12) + 12) % 12;
}

/**
 * Returns sorted, deduplicated extension pitch classes that are not already
 * intrinsic to the given editor quality. Offsets are reduced to pitch-class
 * space, so a compound extension (13 = b9 an octave up) counts as its simple
 * interval. An unknown or absent quality has no intrinsic tones beyond the
 * root, so every extension survives.
 *
 * @param quality Audio-domain ChordQuality ordinal (Major = 0), if known.
 * @param extensions Raw extension semitone offsets, if any.
 * @returns Ascending non-intrinsic extension pitch classes.
 */
export function normalizedChordExtensions(
  quality: number | undefined,
  extensions?: ReadonlyArray<number>,
): number[] {
  const intrinsic = new Set(quality === undefined ? [0] : (TONE_PCS_BY_QUALITY[quality] ?? [0]));
  const out = new Set<number>();
  for (const value of extensions ?? []) {
    if (!Number.isInteger(value)) continue;
    const pc = extensionPitchClass(value);
    if (pc !== 0 && !intrinsic.has(pc)) out.add(pc);
  }
  return [...out].sort((a, b) => a - b);
}

/** Combination key for an editor quality plus its normalized extensions. */
function combinationKey(quality: number, normalized: ReadonlyArray<number>): string {
  return `${quality}:${normalized.join(',')}`;
}

/**
 * Audio-domain quality ordinal -> libcantus quality. Every ordinal maps to an
 * exact libcantus quality.
 */
const AUDIO_QUALITY_TO_LIBCANTUS: Readonly<Record<number, ChordQuality>> = {
  0: 'maj',
  1: 'min',
  2: 'dim',
  3: 'aug',
  4: 'dom7',
  5: 'maj7',
  6: 'min7',
  7: 'sus2',
  8: 'sus4',
  10: 'add9',
  11: 'minAdd9',
  12: 'dim7',
  13: 'm7b5',
  14: 'maj9',
  15: 'dom9',
};

/** Known editor base-quality + normalized-extension combinations. */
const EDITOR_EXTENSIONS_TO_LIBCANTUS: Readonly<Record<string, ChordQuality>> = {
  '0:5': 'add11',
  '0:6': 'majb5',
  '0:9': '6',
  '0:2,9': '6/9',
  '1:2': 'minAdd9',
  '1:9': 'min6',
  '1:11': 'minMaj7',
  '1:2,9': 'min6/9',
  '1:2,11': 'minMaj9',
  '1:2,5,11': 'minMaj11',
  '1:2,9,11': 'minMaj13',
  '3:10': 'aug7',
  '3:11': 'augMaj7',
  '4:1': '7b9',
  '4:3': '7#9',
  '4:5': '11',
  '4:6': '7#11',
  '4:8': '7b13',
  '4:9': '13',
  '4:1,9': '13b9',
  '4:2,9': '13',
  '4:3,8': '7alt',
  '5:6': 'maj7#11',
  '6:2': 'min9',
  '6:2,5': 'min11',
  '6:2,9': 'min13',
  '8:10': '7sus4',
  '14:9': 'maj13',
};

/**
 * Suffixes for editor combinations named directly rather than through the
 * bridge, either because libcantus has no quality string for them or because
 * the quality that would name them does not sound the same tones the editor
 * combination does. Only combinations whose conventional name differs from the
 * generic `base(ext,ext)` fallback belong here.
 */
const DIRECTLY_NAMED_COMBINATION_SUFFIX: Readonly<Record<string, string>> = {
  // A sus4 triad with a ninth and a minor seventh: libcantus has 7sus4 but no
  // 9sus4 quality, and the fallback would print sus4(add9,addb7).
  '8:2,10': '9sus4',
  // A dominant seventh carrying both the ninth and the eleventh. libcantus's
  // `11` omits the third, which the editor combination sounds, so bridging it
  // would silently drop a chord tone; only the name is taken from it.
  '4:2,5': '11',
};

/** Editor-side ordinal plus optional color-tone extensions (semitone offsets). */
export interface EditorQuality {
  quality: number;
  extensions?: number[];
}

/**
 * libcantus quality -> editor ordinal (+ extensions). Qualities the editor
 * cannot name directly degrade to a base ordinal carrying the extra chord tones
 * as `extensions` semitone offsets (9 = 2, 11 = 5, 13 = 9, b9 = 1, #9 = 3,
 * #11 = 6, b13 = 8, maj7-over-triad = 11, dom7-over-aug = 10).
 */
const LIBCANTUS_QUALITY_TO_EDITOR: Readonly<Record<ChordQuality, EditorQuality>> = {
  maj: { quality: 0 },
  min: { quality: 1 },
  dim: { quality: 2 },
  aug: { quality: 3 },
  dom7: { quality: 4 },
  maj7: { quality: 5 },
  min7: { quality: 6 },
  sus2: { quality: 7 },
  sus4: { quality: 8 },
  add9: { quality: 10 },
  dim7: { quality: 12 },
  m7b5: { quality: 13 },
  maj9: { quality: 14 },
  dom9: { quality: 15 },
  minAdd9: { quality: 11 },
  minMaj7: { quality: 1, extensions: [11] },
  minMaj9: { quality: 1, extensions: [11, 2] },
  minMaj11: { quality: 1, extensions: [11, 2, 5] },
  minMaj13: { quality: 1, extensions: [11, 2, 9] },
  aug7: { quality: 3, extensions: [10] },
  augMaj7: { quality: 3, extensions: [11] },
  majb5: { quality: 0, extensions: [6] },
  '6': { quality: 0, extensions: [9] },
  min6: { quality: 1, extensions: [9] },
  '6/9': { quality: 0, extensions: [9, 2] },
  'min6/9': { quality: 1, extensions: [9, 2] },
  add11: { quality: 0, extensions: [5] },
  min9: { quality: 6, extensions: [2] },
  min11: { quality: 6, extensions: [2, 5] },
  min13: { quality: 6, extensions: [2, 9] },
  '7b9': { quality: 4, extensions: [1] },
  '7#9': { quality: 4, extensions: [3] },
  '7#11': { quality: 4, extensions: [6] },
  '7b13': { quality: 4, extensions: [8] },
  '7sus4': { quality: 8, extensions: [10] },
  // A lowered fifth has no editor ordinal; it degrades to the same #11/b5
  // pitch class the editor already uses for majb5.
  '7b5': { quality: 4, extensions: [6] },
  '7alt': { quality: 4, extensions: [3, 8] },
  '11': { quality: 4, extensions: [5] },
  '13': { quality: 4, extensions: [9] },
  '13b9': { quality: 4, extensions: [9, 1] },
  maj13: { quality: 14, extensions: [9] },
  'maj7#11': { quality: 5, extensions: [6] },
  '5': { quality: 0 }, // power chord: no third to name, nearest is a bare major
};

/** Maps an editor quality ordinal to the nearest libcantus quality (default major). */
export function audioQualityToLibcantus(quality: number): ChordQuality {
  return AUDIO_QUALITY_TO_LIBCANTUS[quality] ?? 'maj';
}

/** Maps a libcantus quality to the editor ordinal (+ any degraded extensions). */
export function libcantusQualityToEditor(quality: ChordQuality): EditorQuality {
  return LIBCANTUS_QUALITY_TO_EDITOR[quality] ?? { quality: 0 };
}

/**
 * Exact libcantus quality for an editor base quality plus extensions, or
 * undefined when the combination has no exact quality. Extensions are
 * normalized first; a combination that normalizes to nothing has no exact
 * quality (the base ordinal already names it).
 */
export function editorExtensionQuality(
  quality: number,
  extensions?: ReadonlyArray<number>,
): ChordQuality | undefined {
  const normalized = normalizedChordExtensions(quality, extensions);
  if (normalized.length === 0) return undefined;
  return EDITOR_EXTENSIONS_TO_LIBCANTUS[combinationKey(quality, normalized)];
}

/** Generic readable label for an extension without a named quality mapping. */
function extensionLabel(pc: number): string {
  return (
    (
      {
        1: 'b9',
        2: 'add9',
        3: '#9',
        4: 'add3',
        5: 'add11',
        6: '#11',
        7: 'add5',
        8: 'b13',
        9: 'add13',
        10: 'addb7',
        11: 'addmaj7',
      } as Readonly<Record<number, string>>
    )[pc] ?? `add${pc}`
  );
}

/**
 * Visible chord suffix for an editor quality plus extensions, e.g. 'm7',
 * '13b9', 'sus4(add3)'.
 *
 * The combination is bridged to its exact libcantus quality where one exists
 * and named from {@link QUALITY_SUFFIX}; otherwise the base quality's suffix
 * carries the remaining extensions as a parenthesized list.
 *
 * @param quality Audio-domain ChordQuality ordinal (Major = 0).
 * @param extensions Raw extension semitone offsets, if any.
 * @returns The suffix to append after the chord root (empty for plain major).
 */
export function chordSuffix(quality: number, extensions?: ReadonlyArray<number>): string {
  const normalized = normalizedChordExtensions(quality, extensions);
  const base = QUALITY_SUFFIX[audioQualityToLibcantus(quality)];
  if (normalized.length === 0) return base;
  const key = combinationKey(quality, normalized);
  const direct = DIRECTLY_NAMED_COMBINATION_SUFFIX[key];
  if (direct !== undefined) return direct;
  const exact = EDITOR_EXTENSIONS_TO_LIBCANTUS[key];
  if (exact !== undefined) return QUALITY_SUFFIX[exact];
  return `${base}(${normalized.map(extensionLabel).join(',')})`;
}
