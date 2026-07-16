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
  type HarmonicFunction,
  type KeyScale,
  modalInterchangePalette,
  negativeHarmonyMirror,
  type SubstitutionType,
  substituteChord,
} from '@libraz/libcantus';
import { chordExtensionSignature, type EditorChordSymbol } from '@/project/chords';
import { chordSpanToEditorChord, editorChordToChord } from './chord-io';

/** Where a reharmonization candidate comes from. */
export type ReharmKind = SubstitutionType | 'borrowed' | 'negative';

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
  const subs = substituteChord(chord, key, melodyPcs !== undefined ? { melodyPcs } : undefined);
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
  return modalInterchangePalette(key).map((entry) => ({
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
  const mirror = negativeHarmonyMirror(editorChordToChord(symbol), key);
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

/** Two candidates that replace a chord with the same root/quality/bass. */
function sameChord(a: EditorChordSymbol, b: EditorChordSymbol): boolean {
  return (
    a.rootPc === b.rootPc &&
    a.quality === b.quality &&
    chordExtensionSignature(a) === chordExtensionSignature(b) &&
    (a.bassPc ?? -1) === (b.bassPc ?? -1)
  );
}

/**
 * The full palette of substitutes for a single chord: functional/tritone/etc.
 * substitutions plus the negative-harmony reflection, de-duplicated and with the
 * source chord itself removed (so every entry is an actual alternative).
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
  const candidates = [...substitutionsFor(symbol, key, melodyPcs), negativeHarmonyFor(symbol, key)];
  const seen: EditorChordSymbol[] = [];
  const unique: ReharmCandidate[] = [];
  for (const candidate of candidates) {
    if (sameChord(candidate.symbol, symbol)) continue;
    if (seen.some((prior) => sameChord(prior, candidate.symbol))) continue;
    seen.push(candidate.symbol);
    unique.push(candidate);
  }
  return unique;
}
