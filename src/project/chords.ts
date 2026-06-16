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

/** Sentinel used by the Project annotation encoding for "no pitch class". */
const PC_NONE = 255;

/** Pitch-class display names (sharp spelling), indexed by pitch class 0..11. */
export const CHORD_PITCH_CLASS_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const;

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
  { quality: 2, suffix: 'dim', label: 'Diminished' },
  { quality: 3, suffix: 'aug', label: 'Augmented' },
  { quality: 8, suffix: 'sus4', label: 'Sus4' },
  { quality: 7, suffix: 'sus2', label: 'Sus2' },
  { quality: 12, suffix: 'dim7', label: 'Diminished 7' },
  { quality: 13, suffix: 'm7b5', label: 'Half-diminished' },
];

const SUFFIX_BY_QUALITY = new Map(CHORD_QUALITY_CHOICES.map((c) => [c.quality, c.suffix]));

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
  const suffix = SUFFIX_BY_QUALITY.get(symbol.quality) ?? '';
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
    if (Array.isArray(symbol.extensions) && symbol.extensions.length > 0) {
      const extensions = symbol.extensions.filter((e) => Number.isInteger(e));
      if (extensions.length > 0) next.extensions = extensions;
    }
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
  if (symbol.extensions !== undefined && symbol.extensions.length > 0) {
    input.extensions = [...symbol.extensions];
  }
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
