/**
 * Chord-track model: the project's persistent chord-symbol annotation stream.
 *
 * libsonare's Project stores a chord-symbol stream (`annotateChords`) that is
 * undoable through the project history and round-trips through
 * `toJson()`/`fromJson()`. This module is the app-side representation of that
 * stream: an editor symbol type, conversion to/from the wasm Project encoding
 * (which shifts quality ordinals by one and uses 255 as the "no pitch class"
 * sentinel), a display-name formatter, and document (de)serialization.
 *
 * Chord `quality` here uses the audio-domain `ChordQuality` ordinal
 * (Major = 0), matching `estimateChordSymbols` in src/notation/chords.ts; the
 * +1 shift to the Project's annotation encoding (0 = unknown) is applied only
 * at the wasm boundary. Canvas-free and side-effect-free.
 */

import { PITCH_CLASS_NAMES } from '@/lib/pitch';

/** Sentinel used by the Project annotation encoding for "no pitch class". */
const PC_NONE = 255;

/** Pitch-class display names (sharp spelling), indexed by pitch class 0..11. */
export const CHORD_PITCH_CLASS_NAMES = PITCH_CLASS_NAMES;

/** One selectable chord quality: audio-domain ordinal, name suffix, and label. */
export interface ChordQualityChoice {
  /** Audio-domain ChordQuality ordinal (Major = 0). */
  quality: number;
  /** Chord-symbol suffix appended after the root (e.g. 'm7'). */
  suffix: string;
  /** Human-readable label for the editor dropdown. */
  label: string;
}

/**
 * Chord qualities offered in the editor, in dropdown order. The ordinals and
 * suffixes match the templates in src/notation/chords.ts so detected and
 * hand-entered symbols render identically.
 */
export const CHORD_QUALITY_CHOICES: ReadonlyArray<ChordQualityChoice> = [
  { quality: 0, suffix: '', label: 'Major' },
  { quality: 1, suffix: 'm', label: 'Minor' },
  { quality: 4, suffix: '7', label: 'Dominant 7' },
  { quality: 5, suffix: 'maj7', label: 'Major 7' },
  { quality: 6, suffix: 'm7', label: 'Minor 7' },
  { quality: 10, suffix: 'add9', label: 'Add 9' },
  { quality: 11, suffix: 'm(add9)', label: 'Minor add 9' },
  { quality: 14, suffix: 'maj9', label: 'Major 9' },
  { quality: 15, suffix: '9', label: 'Dominant 9' },
  { quality: 2, suffix: 'dim', label: 'Diminished' },
  { quality: 3, suffix: 'aug', label: 'Augmented' },
  { quality: 8, suffix: 'sus4', label: 'Sus4' },
  { quality: 7, suffix: 'sus2', label: 'Sus2' },
  { quality: 12, suffix: 'dim7', label: 'Diminished 7' },
  { quality: 13, suffix: 'm7b5', label: 'Half-diminished' },
];

const SUFFIX_BY_QUALITY = new Map(CHORD_QUALITY_CHOICES.map((c) => [c.quality, c.suffix]));

/** Intrinsic pitch classes for each editor quality, used to discard redundant extensions. */
const TONE_PCS_BY_QUALITY: Readonly<Record<number, ReadonlyArray<number>>> = {
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

/** Conventional suffixes for base-quality plus extension combinations. */
const SUFFIX_BY_QUALITY_EXTENSIONS: Readonly<Record<string, string>> = {
  '0:5': 'add11',
  '0:6': 'maj♭5',
  '0:9': '6',
  '0:2,9': '6/9',
  '1:2': 'm(add9)',
  '1:9': 'm6',
  '1:11': 'm(maj7)',
  '3:10': 'aug7',
  '3:11': 'aug(maj7)',
  '4:1': '7b9',
  '4:3': '7#9',
  '4:5': '11',
  '4:6': '7#11',
  '4:8': '7b13',
  '4:9': '13',
  '6:2': 'm9',
};

/** Reduces an integer semitone offset to pitch-class space. */
function extensionPitchClass(value: number): number {
  return ((value % 12) + 12) % 12;
}

/** A chord symbol on the project chord track (absolute PPQ region). */
export interface EditorChordSymbol {
  /** Inclusive start of the chord region in absolute PPQ. */
  startPpq: number;
  /** Exclusive end of the chord region in absolute PPQ. */
  endPpq: number;
  /** Root pitch class 0..11 (C = 0). */
  rootPc: number;
  /** Audio-domain ChordQuality ordinal (Major = 0). */
  quality: number;
  /** Slash-bass pitch class 0..11; omitted when the bass is the root. */
  bassPc?: number;
  /** Extension semitone offsets, if any. */
  extensions?: number[];
  /** Optional roman-numeral label. */
  romanNumeral?: string;
}

/**
 * Returns sorted, deduplicated extension pitch classes that are not already
 * intrinsic to the selected editor quality.
 */
export function normalizedChordExtensions(symbol: EditorChordSymbol): number[] {
  const intrinsic = new Set(TONE_PCS_BY_QUALITY[symbol.quality] ?? [0]);
  const extensions = new Set<number>();
  for (const value of symbol.extensions ?? []) {
    if (!Number.isInteger(value)) continue;
    const pc = extensionPitchClass(value);
    if (pc !== 0 && !intrinsic.has(pc)) extensions.add(pc);
  }
  return [...extensions].sort((a, b) => a - b);
}

/** Stable semantic identity for a symbol's non-intrinsic extensions. */
export function chordExtensionSignature(symbol: EditorChordSymbol): string {
  return normalizedChordExtensions(symbol).join(',');
}

/**
 * Whether two chord symbols denote the same chord (root, quality, extension
 * signature, and bass), ignoring their timeline region. An absent bass compares
 * equal only to another absent bass.
 */
export function sameChord(a: EditorChordSymbol, b: EditorChordSymbol): boolean {
  return (
    a.rootPc === b.rootPc &&
    a.quality === b.quality &&
    chordExtensionSignature(a) === chordExtensionSignature(b) &&
    (a.bassPc ?? -1) === (b.bassPc ?? -1)
  );
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

/** Resolves the complete visible suffix, including normalized extensions. */
function chordSuffix(symbol: EditorChordSymbol): string {
  const extensions = normalizedChordExtensions(symbol);
  if (extensions.length === 0) return SUFFIX_BY_QUALITY.get(symbol.quality) ?? '';
  const known = SUFFIX_BY_QUALITY_EXTENSIONS[`${symbol.quality}:${extensions.join(',')}`];
  if (known !== undefined) return known;
  const base = SUFFIX_BY_QUALITY.get(symbol.quality) ?? '';
  return `${base}(${extensions.map(extensionLabel).join(',')})`;
}

/** Chord-symbol payload accepted by `Project.annotateChords`. */
export interface ProjectChordSymbolInput {
  startPpq: number;
  endPpq: number;
  rootPc: number;
  /** ChordQuality ordinal in the Project encoding (0 = unknown, 1 = major). */
  quality: number;
  slashBassPc: number;
  extensions?: number[];
  romanNumeral?: string;
}

/** One serialized chord inside `Project.toJson().annotation.chords`. */
interface SerializedAnnotationChord {
  start_ppq: number;
  end_ppq: number;
  root_pc: number;
  quality: number;
  slash_bass_pc: number;
  roman_numeral: string;
  extensions?: number[];
}

function clampPitchClass(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const pc = Math.round(value);
  return pc >= 0 && pc <= 11 ? pc : null;
}

/** Formats a chord symbol for display, e.g. "Cmaj7", "Am7/G". */
export function formatChordName(symbol: EditorChordSymbol): string {
  const root = CHORD_PITCH_CLASS_NAMES[((symbol.rootPc % 12) + 12) % 12] ?? '?';
  const suffix = chordSuffix(symbol);
  const name = `${root}${suffix}`;
  if (symbol.bassPc === undefined || symbol.bassPc === symbol.rootPc) return name;
  const bass = CHORD_PITCH_CLASS_NAMES[((symbol.bassPc % 12) + 12) % 12] ?? '?';
  return `${name}/${bass}`;
}

/**
 * Normalizes a chord list: drops symbols with an invalid root or a
 * non-positive region, clamps pitch classes, and sorts by start position.
 *
 * @param symbols Raw chord symbols (not mutated).
 * @returns Sanitized symbols sorted by `startPpq`.
 */
export function sanitizeChordSymbols(
  symbols: ReadonlyArray<EditorChordSymbol>,
): EditorChordSymbol[] {
  const out: EditorChordSymbol[] = [];
  for (const symbol of symbols) {
    const rootPc = clampPitchClass(symbol.rootPc);
    if (rootPc === null) continue;
    if (!Number.isFinite(symbol.startPpq) || !Number.isFinite(symbol.endPpq)) continue;
    if (symbol.endPpq <= symbol.startPpq) continue;
    const quality = Number.isInteger(symbol.quality) ? symbol.quality : 0;
    const next: EditorChordSymbol = {
      startPpq: symbol.startPpq,
      endPpq: symbol.endPpq,
      rootPc,
      quality,
    };
    const bassPc = symbol.bassPc === undefined ? null : clampPitchClass(symbol.bassPc);
    if (bassPc !== null && bassPc !== rootPc) next.bassPc = bassPc;
    const extensions = normalizedChordExtensions(symbol);
    if (extensions.length > 0) next.extensions = extensions;
    if (typeof symbol.romanNumeral === 'string' && symbol.romanNumeral.length > 0) {
      next.romanNumeral = symbol.romanNumeral;
    }
    out.push(next);
  }
  out.sort((a, b) => a.startPpq - b.startPpq || a.endPpq - b.endPpq);
  return out;
}

/**
 * Converts an editor chord symbol into the `Project.annotateChords` encoding
 * (quality shifted by one; the slash bass replaced with the 255 sentinel when
 * absent or equal to the root).
 */
export function toProjectChordSymbol(symbol: EditorChordSymbol): ProjectChordSymbolInput {
  const input: ProjectChordSymbolInput = {
    startPpq: symbol.startPpq,
    endPpq: symbol.endPpq,
    rootPc: symbol.rootPc,
    quality: symbol.quality + 1,
    slashBassPc:
      symbol.bassPc === undefined || symbol.bassPc === symbol.rootPc ? PC_NONE : symbol.bassPc,
  };
  const extensions = normalizedChordExtensions(symbol);
  if (extensions.length > 0) input.extensions = extensions;
  if (symbol.romanNumeral !== undefined && symbol.romanNumeral.length > 0) {
    input.romanNumeral = symbol.romanNumeral;
  }
  return input;
}

/** Maps an editor chord list to the Project annotation payload. */
export function toProjectChordSymbols(
  symbols: ReadonlyArray<EditorChordSymbol>,
): ProjectChordSymbolInput[] {
  return symbols.map(toProjectChordSymbol);
}

/**
 * Reads the chord-symbol stream back from a parsed `Project.toJson()` document
 * (the `annotation.chords` array), converting the Project encoding to editor
 * symbols. Malformed entries are skipped; the result is sanitized and sorted.
 *
 * @param annotation The document's `annotation` object (or undefined).
 * @returns Editor chord symbols, sorted by start position.
 */
export function chordsFromAnnotation(annotation: unknown): EditorChordSymbol[] {
  if (typeof annotation !== 'object' || annotation === null) return [];
  const chords = (annotation as { chords?: unknown }).chords;
  if (!Array.isArray(chords)) return [];
  const out: EditorChordSymbol[] = [];
  for (const raw of chords as SerializedAnnotationChord[]) {
    if (typeof raw.root_pc !== 'number' || raw.root_pc < 0 || raw.root_pc > 11) continue;
    const symbol: EditorChordSymbol = {
      startPpq: raw.start_ppq,
      endPpq: raw.end_ppq,
      rootPc: raw.root_pc,
      quality: raw.quality >= 1 ? raw.quality - 1 : 0,
    };
    if (raw.slash_bass_pc >= 0 && raw.slash_bass_pc <= 11 && raw.slash_bass_pc !== raw.root_pc) {
      symbol.bassPc = raw.slash_bass_pc;
    }
    if (Array.isArray(raw.extensions) && raw.extensions.length > 0) {
      symbol.extensions = raw.extensions.filter((e) => Number.isInteger(e));
    }
    if (typeof raw.roman_numeral === 'string' && raw.roman_numeral.length > 0) {
      symbol.romanNumeral = raw.roman_numeral;
    }
    out.push(symbol);
  }
  return sanitizeChordSymbols(out);
}
