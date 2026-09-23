/**
 * Reharmonization candidates for the editor's chord track.
 *
 * A thin adapter over libcantus's reharmony API ({@link substituteChord},
 * {@link modalInterchangePalette}, {@link negativeHarmonyMirror}). It turns an
 * {@link EditorChordSymbol} (or a bare key) into a list of alternative chords
 * placed over the same PPQ region, each carrying its Roman numeral and
 * relationship so a palette can label them. These are creative tools invoked
 * explicitly by the user; they are never mixed into the safety guidance or the
 * automatic generators.
 *
 * Pure module. `negativeHarmonyMirror`/chromatic-mediant substitutions are
 * intentionally adventurous (beyond the pop default vocabulary) and are surfaced
 * only through this palette.
 */

import {
  chordPitchClasses,
  classifyMelodyTones,
  type HarmonicFunction,
  type KeyScale,
  modalInterchangePalette,
  negativeHarmonyMirror,
  type SubstitutionType,
  spelledKeyOf,
  substituteChord,
  type TimeSignature,
} from '@libraz/libcantus';
import { type EditorChordSymbol, sameChord } from '@/project/chords';
import { chordSpanToEditorChord, editorChordToChord } from './chord-io';

/** Meter assumed when the caller names none, matching the library's own default. */
const DEFAULT_MELODY_METER: TimeSignature = { numerator: 4, denominator: 4 };

/** Where a reharmonization candidate comes from. */
export type ReharmKind = SubstitutionType | 'borrowed' | 'negative';

/** Minimal note shape for melody extraction (absolute timeline PPQ). */
export interface RegionNote {
  pitch: number;
  startPpq: number;
  durationPpq: number;
}

/** Options for selecting the structural melody tones that constrain a palette. */
export interface MelodyPitchClassOptions {
  /** Meter governing the region, used to weight metric accents; 4/4 by default. */
  ts?: TimeSignature;
}

/** The top voice of an arrangement: the highest note at each distinct onset. */
function topVoiceLine(
  notes: ReadonlyArray<RegionNote>,
  epsilon: number,
): Array<RegionNote & { pc: number }> {
  const sorted = [...notes].sort((a, b) => a.startPpq - b.startPpq || b.pitch - a.pitch);
  const line: Array<RegionNote & { pc: number }> = [];
  let groupStart = Number.NEGATIVE_INFINITY;
  for (const note of sorted) {
    if (note.startPpq - groupStart <= epsilon) continue;
    line.push({ ...note, pc: ((note.pitch % 12) + 12) % 12 });
    groupStart = note.startPpq;
  }
  return line;
}

/**
 * Structural pitch classes of the melody (top voice) sounding within a chord
 * region, for melody-preserving reharmonization.
 *
 * Which notes are structural is read rather than guessed at: the whole top
 * voice is classified into its melodic figures — suspensions, passing and
 * neighbour tones, anticipations, appoggiaturas, escapes — and the ornamental
 * ones are dropped, so a weak short passing tone never becomes a hard chord-tone
 * constraint. The line is classified whole and then cut to the region, because a
 * figure is recognized from the notes framing it: classifying the region alone
 * would read its first and last notes as structural whatever they are.
 *
 * A note sustained into the region from before it is always structural — it is
 * sounding when the chord arrives, whatever its role in the line.
 *
 * @param notes Arrangement notes at absolute timeline PPQ (percussion excluded
 *   by the caller).
 * @param startPpq Region start (inclusive).
 * @param endPpq Region end (exclusive).
 * @param epsilon Onset-grouping tolerance in PPQ (default 1e-6).
 * @param options Meter governing the region.
 */
export function melodyPitchClassesInRegion(
  notes: ReadonlyArray<RegionNote>,
  startPpq: number,
  endPpq: number,
  epsilon = 1e-6,
  options: MelodyPitchClassOptions = {},
): number[] {
  const line = topVoiceLine(notes, epsilon);
  if (line.length === 0) return [];
  const roles = classifyMelodyTones(
    line.map((note) => ({
      pitch: note.pitch,
      startBeat: note.startPpq,
      durationBeat: note.durationPpq,
    })),
    options.ts ?? DEFAULT_MELODY_METER,
  );
  const inRegion = line.flatMap((note, index) =>
    note.startPpq < endPpq && note.startPpq + note.durationPpq > startPpq
      ? [{ note, ornamental: roles[index]?.ornamental === true }]
      : [],
  );
  if (inRegion.length === 0) return [];
  const structural = inRegion.filter(
    (entry) => entry.note.startPpq < startPpq || !entry.ornamental,
  );
  // A region made entirely of ornament still has to constrain something; the
  // longest note in it is the one the ear holds on to.
  const selected =
    structural.length > 0
      ? structural
      : [...inRegion]
          .sort(
            (a, b) =>
              overlapPpq(b.note, startPpq, endPpq) - overlapPpq(a.note, startPpq, endPpq) ||
              a.note.startPpq - b.note.startPpq,
          )
          .slice(0, 2);
  return [...new Set(selected.map((entry) => entry.note.pc))].sort((a, b) => a - b);
}

/** How much of a note sounds inside a region. */
function overlapPpq(note: RegionNote, startPpq: number, endPpq: number): number {
  return Math.min(note.startPpq + note.durationPpq, endPpq) - Math.max(note.startPpq, startPpq);
}

/** One reharmonization candidate placed over a chord region. */
export interface ReharmCandidate {
  /** The substitute chord over the same PPQ region as the source. */
  symbol: EditorChordSymbol;
  /** Roman numeral of the candidate in the prevailing key. */
  roman: string;
  /** The relationship that produced this candidate. */
  kind: ReharmKind;
  /** Harmonic function in the key, when libcantus reports one. */
  function?: HarmonicFunction;
}

/**
 * Substitution candidates for a chord symbol within a key.
 *
 * @param symbol The chord to reharmonize (its region is reused for candidates).
 * @param key The prevailing key.
 * @param melodyPcs Pitch classes that must stay chord tones (melody-preserving);
 *   candidates missing any are dropped.
 */
export function substitutionsFor(
  symbol: EditorChordSymbol,
  key: KeyScale,
  melodyPcs?: number[],
): ReharmCandidate[] {
  const chord = editorChordToChord(symbol);
  const subs = substituteChord(
    chord,
    spelledKeyOf(key),
    melodyPcs !== undefined ? { melodyPcs } : undefined,
  );
  return subs.map((sub) => ({
    symbol: chordSpanToEditorChord(
      {
        rootPc: sub.chord.rootPc,
        quality: sub.chord.quality,
        startBeat: 0,
        bassPc: sub.chord.bassPc,
      },
      symbol.startPpq,
      symbol.endPpq,
    ),
    roman: sub.roman,
    kind: sub.type,
    function: sub.function,
  }));
}

/**
 * The modal-interchange (borrowed-chord) palette of a key, each candidate placed
 * over the given region.
 *
 * @param key The prevailing key.
 * @param region The PPQ region the borrowed chords would occupy.
 */
export function modalInterchangeFor(
  key: KeyScale,
  region: { startPpq: number; endPpq: number },
): ReharmCandidate[] {
  return modalInterchangePalette(spelledKeyOf(key)).map((entry) => ({
    symbol: chordSpanToEditorChord(
      {
        rootPc: entry.chord.rootPc,
        quality: entry.chord.quality,
        startBeat: 0,
        bassPc: entry.chord.bassPc,
      },
      region.startPpq,
      region.endPpq,
    ),
    roman: entry.roman,
    kind: 'borrowed',
  }));
}

/**
 * The negative-harmony reflection of a chord across the key's tonic–dominant
 * axis, placed over the source region.
 *
 * @param symbol The chord to reflect.
 * @param key The prevailing key.
 */
export function negativeHarmonyFor(symbol: EditorChordSymbol, key: KeyScale): ReharmCandidate {
  const mirror = negativeHarmonyMirror(editorChordToChord(symbol), spelledKeyOf(key));
  return {
    symbol: chordSpanToEditorChord(
      { rootPc: mirror.rootPc, quality: mirror.quality, startBeat: 0, bassPc: mirror.bassPc },
      symbol.startPpq,
      symbol.endPpq,
    ),
    roman: '',
    kind: 'negative',
  };
}

/**
 * The full palette of substitutes for a single chord: functional/tritone/etc.
 * substitutions, modal-interchange and negative-harmony candidates,
 * de-duplicated and with the source chord itself removed (so every entry is an
 * actual alternative).
 *
 * @param symbol The chord to reharmonize.
 * @param key The prevailing key.
 * @param melodyPcs Pitch classes that must stay chord tones, when constraining.
 */
export function reharmCandidatesFor(
  symbol: EditorChordSymbol,
  key: KeyScale,
  melodyPcs?: number[],
): ReharmCandidate[] {
  const candidates = [
    ...substitutionsFor(symbol, key, melodyPcs),
    ...modalInterchangeFor(key, symbol),
    negativeHarmonyFor(symbol, key),
  ];
  const seen: EditorChordSymbol[] = [];
  const unique: ReharmCandidate[] = [];
  for (const candidate of candidates) {
    // libcantus applies this constraint to substitution candidates, but the
    // modal-interchange and negative-harmony palettes are assembled here.
    // Filter every source uniformly so the selected melody never becomes a
    // non-chord tone merely because it came from a different palette.
    if (
      melodyPcs !== undefined &&
      !melodyPcs.every((pc) => chordPitchClasses(editorChordToChord(candidate.symbol)).includes(pc))
    ) {
      continue;
    }
    if (sameChord(candidate.symbol, symbol)) continue;
    if (seen.some((prior) => sameChord(prior, candidate.symbol))) continue;
    seen.push(candidate.symbol);
    unique.push(candidate);
  }
  return unique;
}
