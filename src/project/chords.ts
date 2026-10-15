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

import type { NoteNameSystem } from '@libraz/libcantus';
import {
  chordSuffix,
  normalizedChordExtensions,
  normalizedChordOmissions,
  TONE_PCS_BY_QUALITY,
} from '@/compose/chord-quality';
import { chordPitchClassName } from '@/notation/pitch-spelling';

/** Sentinel used by the Project annotation encoding for "no pitch class". */
const PC_NONE = 255;

/** One selectable chord quality: audio-domain ordinal, name suffix, and label. */
export interface ChordQualityChoice {
  /** Audio-domain ChordQuality ordinal (Major = 0). */
  quality: number;
  /** Chord-symbol suffix appended after the root (e.g. 'm7'). */
  suffix: string;
  /** Human-readable label for the editor dropdown. */
  label: string;
  /** Non-intrinsic root-relative tones selected with this quality. */
  extensions?: ReadonlyArray<number>;
  /** Intrinsic tones of the ordinal this chord does not sound. */
  omissions?: ReadonlyArray<number>;
}

/** A dropdown entry before its suffix is resolved from the shared naming table. */
interface ChordQualityChoiceSpec {
  quality: number;
  label: string;
  extensions?: ReadonlyArray<number>;
  omissions?: ReadonlyArray<number>;
}

/** Chord qualities offered in the editor, in dropdown order. */
const CHORD_QUALITY_CHOICE_SPECS: ReadonlyArray<ChordQualityChoiceSpec> = [
  { quality: 0, label: 'Major' },
  { quality: 1, label: 'Minor' },
  { quality: 4, label: 'Dominant 7' },
  { quality: 5, label: 'Major 7' },
  { quality: 6, label: 'Minor 7' },
  { quality: 10, label: 'Add 9' },
  { quality: 11, label: 'Minor add 9' },
  { quality: 14, label: 'Major 9' },
  { quality: 15, label: 'Dominant 9' },
  { quality: 0, label: 'Major 6', extensions: [9] },
  { quality: 1, label: 'Minor 6', extensions: [9] },
  { quality: 8, label: 'Dominant 7 sus4', extensions: [10] },
  { quality: 8, label: 'Dominant 9 sus4', extensions: [2, 10] },
  // An eleventh a semitone above the major third replaces it rather than
  // sounding against it, which is what the name C11 has always meant.
  { quality: 4, label: 'Dominant 11', extensions: [2, 5], omissions: [4] },
  { quality: 4, label: 'Dominant 13', extensions: [2, 9] },
  { quality: 4, label: 'Dominant 7 b9 #11', extensions: [1, 6] },
  // The flat thirteenth is the raised fifth, standing in place of the perfect
  // fifth rather than grinding against it.
  { quality: 4, label: 'Dominant 7 #9 b13', extensions: [3, 8], omissions: [7] },
  { quality: 2, label: 'Diminished' },
  { quality: 3, label: 'Augmented' },
  { quality: 8, label: 'Sus4' },
  { quality: 7, label: 'Sus2' },
  // A root and a fifth with the third left silent, which no combination of
  // added tones can describe.
  { quality: 0, label: 'Power chord', omissions: [4] },
  { quality: 12, label: 'Diminished 7' },
  { quality: 13, label: 'Half-diminished' },
];

/**
 * Selectable chord qualities with their display suffix resolved through
 * {@link chordSuffix}, so a dropdown entry always names the symbol the chord
 * track, the score view and MusicXML export then print.
 */
export const CHORD_QUALITY_CHOICES: ReadonlyArray<ChordQualityChoice> =
  CHORD_QUALITY_CHOICE_SPECS.map((spec) => ({
    ...spec,
    suffix: chordSuffix(spec.quality, spec.extensions, spec.omissions),
  }));

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
  /**
   * Intrinsic tones of `quality` this chord does not sound, as root-relative
   * semitone offsets. An ordinal names a fixed tone set, so a chord that is
   * that set minus a tone (a power chord, a lowered fifth standing in for the
   * perfect fifth) can only be described by naming what is absent.
   */
  omissions?: number[];
  /** Optional roman-numeral label. */
  romanNumeral?: string;
}

/** Non-intrinsic extension pitch classes of a chord symbol, ascending. */
function symbolExtensions(symbol: EditorChordSymbol): number[] {
  return normalizedChordExtensions(symbol.quality, symbol.extensions);
}

/** Intrinsic pitch classes the symbol declares silent, ascending. */
function symbolOmissions(symbol: EditorChordSymbol): number[] {
  return normalizedChordOmissions(symbol.quality, symbol.omissions);
}

/**
 * Absolute pitch classes a chord symbol asks for: its quality's intrinsic
 * tones, less any it omits, plus any extensions, transposed to the symbol's
 * root, with the slash bass added when the symbol has one.
 */
export function chordTonePitchClasses(symbol: EditorChordSymbol): number[] {
  const rootRelative = new Set<number>(TONE_PCS_BY_QUALITY[symbol.quality] ?? [0]);
  for (const omission of symbolOmissions(symbol)) rootRelative.delete(omission);
  for (const extension of symbolExtensions(symbol)) rootRelative.add(extension);
  const absolute = new Set<number>();
  for (const offset of rootRelative) absolute.add((symbol.rootPc + offset) % 12);
  if (symbol.bassPc !== undefined) absolute.add(symbol.bassPc % 12);
  return [...absolute].sort((a, b) => a - b);
}

/**
 * Stable semantic identity for the tones a symbol adds to and removes from its
 * ordinal. Two chords sharing a root, quality and bass are the same chord only
 * when this agrees, so an omitted fifth is not identified with a sounded one.
 */
export function chordExtensionSignature(symbol: EditorChordSymbol): string {
  const omissions = symbolOmissions(symbol);
  const extensions = symbolExtensions(symbol).join(',');
  return omissions.length === 0 ? extensions : `${extensions}/${omissions.join(',')}`;
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

/**
 * Formats a chord symbol for display, e.g. "Cmaj7", "Am7/G".
 *
 * `keyFifths` uses the MusicXML convention. Borrowed chord degrees use the
 * conventional flat spelling while #I/#IV use sharps, matching score export.
 *
 * Only the root and bass follow `system`; the quality suffix is an
 * international convention and stays ASCII in every system, so a Japanese
 * reading of Cmaj7 is "ハmaj7".
 */
export function formatChordName(
  symbol: EditorChordSymbol,
  keyFifths = 0,
  system: NoteNameSystem = 'english',
): string {
  const root = chordPitchClassName(symbol.rootPc, keyFifths, system);
  const suffix = chordSuffix(symbol.quality, symbol.extensions, symbol.omissions);
  const name = `${root}${suffix}`;
  if (symbol.bassPc === undefined || symbol.bassPc === symbol.rootPc) return name;
  const bass = chordPitchClassName(symbol.bassPc, keyFifths, system);
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
    const extensions = symbolExtensions(symbol);
    if (extensions.length > 0) next.extensions = extensions;
    const omissions = symbolOmissions(symbol);
    if (omissions.length > 0) next.omissions = omissions;
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
 *
 * The Project encoding has no field for omitted tones, so `omissions` does not
 * survive the round trip through `toJson()`. The document, not the annotation
 * stream, is the record of a chord's structure; the read-back is seeded with
 * what the app already holds (see {@link chordsFromAnnotation}).
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
  const extensions = symbolExtensions(symbol);
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

/** PPQ hint keys are rounded at micro-PPQ resolution to absorb float drift. */
const HINT_PPQ_SCALE = 1e6;

/** Whether a read-back symbol is the hinted chord with its omissions dropped. */
function isSameChordBeforeOmissions(read: EditorChordSymbol, hint: EditorChordSymbol): boolean {
  return (
    read.rootPc === hint.rootPc &&
    read.quality === hint.quality &&
    (read.bassPc ?? -1) === (hint.bassPc ?? -1) &&
    normalizedChordExtensions(read.quality, read.extensions).join(',') ===
      normalizedChordExtensions(hint.quality, hint.extensions).join(',')
  );
}

/**
 * Reads the chord-symbol stream back from a parsed `Project.toJson()` document
 * (the `annotation.chords` array), converting the Project encoding to editor
 * symbols. Malformed entries are skipped; the result is sanitized and sorted.
 *
 * The Project encoding has no field for omitted tones, so a chord that omits
 * one would come back sounding it. `hints` seeds the read-back with the chords
 * the app already holds: where a symbol at the same position is the hint with
 * its omissions dropped, the omissions are restored. Any other difference means
 * the chord changed inside the Project, and that reading wins -- the seed
 * retains app-level structure, it does not override the engine.
 *
 * @param annotation The document's `annotation` object (or undefined).
 * @param hints Chords expected at these positions, if the caller has them.
 * @returns Editor chord symbols, sorted by start position.
 */
export function chordsFromAnnotation(
  annotation: unknown,
  hints?: ReadonlyArray<EditorChordSymbol>,
): EditorChordSymbol[] {
  if (typeof annotation !== 'object' || annotation === null) return [];
  const chords = (annotation as { chords?: unknown }).chords;
  if (!Array.isArray(chords)) return [];
  const hintByStart = new Map<number, EditorChordSymbol>();
  for (const hint of hints ?? []) {
    if (hint.omissions !== undefined && hint.omissions.length > 0) {
      hintByStart.set(Math.round(hint.startPpq * HINT_PPQ_SCALE), hint);
    }
  }
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
    const hint = hintByStart.get(Math.round(symbol.startPpq * HINT_PPQ_SCALE));
    if (hint !== undefined && isSameChordBeforeOmissions(symbol, hint)) {
      symbol.omissions = [...(hint.omissions ?? [])];
    }
    out.push(symbol);
  }
  return sanitizeChordSymbols(out);
}
