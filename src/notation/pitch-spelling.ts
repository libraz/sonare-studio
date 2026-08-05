/**
 * Pitch spelling for the display-only notation pipeline.
 *
 * Converts MIDI note numbers to MusicXML-style spelled pitches
 * (step/alter/octave) using the key signature to choose between sharp and
 * flat spellings, and converts between MusicXML key fifths and libsonare
 * key descriptions.
 */

import type { Key, Mode } from '@/wasm/index.js';

/** Diatonic step letter (MusicXML `<step>`). */
export type Step = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

/** A spelled pitch following MusicXML conventions (C4 = MIDI 60). */
export interface SpelledPitch {
  /** Step letter A-G. */
  step: Step;
  /** Chromatic alteration: -2 = double-flat through 2 = double-sharp. */
  alter: -2 | -1 | 0 | 1 | 2;
  /** Scientific octave number (MusicXML `<octave>`; C4 = MIDI 60). */
  octave: number;
}

/** Sharp-side spelling for each pitch class (C = 0). */
const SHARP_SPELLINGS: ReadonlyArray<Readonly<Pick<SpelledPitch, 'step' | 'alter'>>> = [
  { step: 'C', alter: 0 },
  { step: 'C', alter: 1 },
  { step: 'D', alter: 0 },
  { step: 'D', alter: 1 },
  { step: 'E', alter: 0 },
  { step: 'F', alter: 0 },
  { step: 'F', alter: 1 },
  { step: 'G', alter: 0 },
  { step: 'G', alter: 1 },
  { step: 'A', alter: 0 },
  { step: 'A', alter: 1 },
  { step: 'B', alter: 0 },
];

/** Flat-side spelling for each pitch class (C = 0). */
const FLAT_SPELLINGS: ReadonlyArray<Readonly<Pick<SpelledPitch, 'step' | 'alter'>>> = [
  { step: 'C', alter: 0 },
  { step: 'D', alter: -1 },
  { step: 'D', alter: 0 },
  { step: 'E', alter: -1 },
  { step: 'E', alter: 0 },
  { step: 'F', alter: 0 },
  { step: 'G', alter: -1 },
  { step: 'G', alter: 0 },
  { step: 'A', alter: -1 },
  { step: 'A', alter: 0 },
  { step: 'B', alter: -1 },
  { step: 'B', alter: 0 },
];

const STEP_SEMITONES: Record<Step, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

const STEPS: readonly Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

const SHARP_STEPS: readonly Step[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_STEPS: readonly Step[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

/** Key-signature alteration for a diatonic step. */
function keySignatureAlter(step: Step, fifths: number): SpelledPitch['alter'] {
  if (fifths > 0 && SHARP_STEPS.slice(0, fifths).includes(step)) return 1;
  if (fifths < 0 && FLAT_STEPS.slice(0, -fifths).includes(step)) return -1;
  return 0;
}

/** Signature spelling when a pitch class is one of the key's seven scale tones. */
function signatureSpelling(
  pitchClass: number,
  fifths: number,
): Pick<SpelledPitch, 'step' | 'alter'> | undefined {
  for (const step of Object.keys(STEP_SEMITONES) as Step[]) {
    const alter = keySignatureAlter(step, fifths);
    if ((STEP_SEMITONES[step] + alter + 12) % 12 === pitchClass) return { step, alter };
  }
  return undefined;
}

/** Derives MusicXML's octave after spelling has crossed B#/Cb boundaries. */
function octaveForSpelling(midi: number, step: Step, alter: SpelledPitch['alter']): number {
  let octave = Math.floor(midi / 12) - 1;
  if (step === 'B' && alter > 0) octave -= 1;
  if (step === 'C' && alter < 0) octave += 1;
  return octave;
}

/**
 * Spells a MIDI pitch as step/alter/octave for a given key signature.
 *
 * Scale tones are first spelled from the actual key signature, so extreme
 * signatures retain E#/B# and Cb/Fb. Remaining chromatic tones use a sharp
 * or flat fallback according to the signature side. The octave follows
 * MusicXML scientific pitch notation (MIDI 60 = C4), including B#/Cb octave
 * crossings.
 *
 * @param midi MIDI note number (integer 0-127).
 * @param keyFifths Key signature as MusicXML fifths (-7..7; >= 0 spells sharps).
 * @returns The spelled pitch.
 * @throws RangeError If `midi` is not an integer in 0-127.
 */
export function spellPitch(midi: number, keyFifths: number): SpelledPitch {
  if (!Number.isInteger(midi) || midi < 0 || midi > 127) {
    throw new RangeError(`spellPitch: midi must be an integer in 0-127, got ${midi}`);
  }
  const pitchClass = midi % 12;
  const fallback = (keyFifths < 0 ? FLAT_SPELLINGS : SHARP_SPELLINGS)[pitchClass];
  const { step, alter } = signatureSpelling(pitchClass, keyFifths) ?? fallback;
  return { step, alter, octave: octaveForSpelling(midi, step, alter) };
}

/** Extra harmonic/melodic evidence used to disambiguate chromatic spellings. */
export interface PitchSpellingContext {
  /** Lowest pitch of a simultaneous chord, when the event is chordal. */
  chordRootMidi?: number;
  /** Previous sounding pitch in the same notated voice. */
  previousMidi?: number;
  /** Next sounding pitch in the same notated voice. */
  nextMidi?: number;
}

function signedPitchClassDistance(from: number, to: number): number {
  const distance = (((to - from) % 12) + 12) % 12;
  return distance > 6 ? distance - 12 : distance;
}

function stepIndex(step: Step): number {
  return STEPS.indexOf(step);
}

function ascendingStepDistance(from: Step, to: Step): number {
  return (stepIndex(to) - stepIndex(from) + 7) % 7;
}

function chromaticCandidates(midi: number): SpelledPitch[] {
  const pitchClass = midi % 12;
  const candidates: SpelledPitch[] = [];
  for (const step of STEPS) {
    const difference = signedPitchClassDistance(STEP_SEMITONES[step], pitchClass);
    if (difference < -2 || difference > 2) continue;
    candidates.push({
      step,
      alter: difference as SpelledPitch['alter'],
      octave: octaveForSpelling(midi, step, difference as SpelledPitch['alter']),
    });
  }
  return candidates;
}

/**
 * Spells a chromatic note using local musical context in addition to a key
 * signature. The plain {@link spellPitch} remains the stable fallback for
 * callers which only have a pitch class. At score-export time this resolves
 * raised leading tones (C#→D in D minor), secondary dominants (D–F#–A), and
 * double sharps such as F##→G# without changing the underlying MIDI data.
 */
export function spellPitchWithContext(
  midi: number,
  keyFifths: number,
  context: PitchSpellingContext = {},
): SpelledPitch {
  const fallback = spellPitch(midi, keyFifths);
  const candidates = chromaticCandidates(midi);
  if (candidates.length === 1) return candidates[0];
  const rootMidi = context.chordRootMidi;
  const rootSpelling =
    rootMidi === undefined ? undefined : spellChordPitchClass(rootMidi % 12, keyFifths);
  const previous =
    context.previousMidi === undefined ? undefined : spellPitch(context.previousMidi, keyFifths);
  const next = context.nextMidi === undefined ? undefined : spellPitch(context.nextMidi, keyFifths);
  const score = (candidate: SpelledPitch): number => {
    let value = candidate.step === fallback.step && candidate.alter === fallback.alter ? 1 : 0;
    if (rootMidi !== undefined && rootSpelling !== undefined) {
      if (rootMidi === midi) {
        if (candidate.step === rootSpelling.step && candidate.alter === rootSpelling.alter)
          value += 10;
      } else {
        const semitones = (((midi - rootMidi) % 12) + 12) % 12;
        const expectedSteps = [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6][semitones];
        if (ascendingStepDistance(rootSpelling.step, candidate.step) === expectedSteps) value += 10;
      }
    }
    if (previous !== undefined && context.previousMidi !== undefined) {
      const resolvesDownwardByStep =
        midi < context.previousMidi &&
        previous.alter === 0 &&
        ascendingStepDistance(candidate.step, previous.step) === 1;
      if (resolvesDownwardByStep) value += 4;
    }
    if (next !== undefined && context.nextMidi !== undefined) {
      const motion = context.nextMidi - midi;
      const resolvesUpwardByStep =
        motion > 0 &&
        ((ascendingStepDistance(candidate.step, next.step) === 1 && next.alter === 0) ||
          candidate.alter === 2);
      if (resolvesUpwardByStep) value += 4;
    }
    return value;
  };
  return candidates.reduce((best, candidate) =>
    score(candidate) > score(best) ? candidate : best,
  );
}

/**
 * Spells a pitch class for a chord symbol rather than a sounding note.
 *
 * Chord roots need functional readability in addition to the key signature:
 * borrowed bII/bIII/bVI/bVII conventionally use flats, while #IV uses a
 * sharp. A bare pitch class cannot distinguish bII from #I, so the common
 * borrowed-degree reading is chosen unless a caller carries extra context.
 * Diatonic scale tones still retain the exact spelling of extreme
 * key signatures (for example E# in F# major).
 */
export function spellChordPitchClass(
  pitchClass: number,
  keyFifths: number,
): Pick<SpelledPitch, 'step' | 'alter'> {
  const normalized = ((Math.round(pitchClass) % 12) + 12) % 12;
  const diatonic = signatureSpelling(normalized, keyFifths);
  if (diatonic) return diatonic;

  const tonicPitchClass = (((keyFifths * 7) % 12) + 12) % 12;
  const degree = (normalized - tonicPitchClass + 12) % 12;
  // #IV is the conventional sharp-side chromatic degree. Other ambiguous
  // pitch classes default to the more common borrowed flat-degree reading.
  return (degree === 6 ? SHARP_SPELLINGS : FLAT_SPELLINGS)[normalized];
}

/** Formats a chord pitch class as a display token such as `Bb` or `F#`. */
export function chordPitchClassName(pitchClass: number, keyFifths: number): string {
  const spelled = spellChordPitchClass(pitchClass, keyFifths);
  const accidental = spelled.alter === 0 ? '' : spelled.alter > 0 ? '#' : 'b';
  return `${spelled.step}${accidental}`;
}

/**
 * Key-fifths offset of each libsonare `Mode` relative to the major key with
 * the same tonic (index = audio `Mode` ordinal: Major, Minor, Dorian,
 * Phrygian, Lydian, Mixolydian, Locrian).
 */
const MODE_FIFTHS_OFFSET: ReadonlyArray<number> = [0, -3, -2, -4, 1, -1, -5];

/**
 * Normalizes a fifths count to the canonical range -5..6 (enharmonic keys
 * outside the range collapse, e.g. Cb major -7 -> B major 5).
 */
function normalizeFifths(fifths: number): number {
  const mod = ((fifths % 12) + 12) % 12;
  return mod > 6 ? mod - 12 : mod;
}

/**
 * Computes the MusicXML key fifths for a libsonare key (tonic + mode).
 *
 * The tonic pitch class alone cannot distinguish enharmonic key spellings,
 * so the result is normalized to -5..6 (e.g. tonic pc 6 major -> 6 = F#
 * major, never -6 = Gb major).
 *
 * @param key Tonic pitch class and mode (libsonare audio `Mode` ordinals,
 *   Major = 0; not the +1-shifted `ProjectKeySegment.mode` encoding).
 * @returns Key signature fifths in -5..6.
 */
export function keyToKeyFifths(key: Pick<Key, 'root' | 'mode'>): number {
  // 7 is the multiplicative inverse of 7 mod 12, so pc * 7 mod 12 inverts
  // "fifths -> tonic pc" for major; the mode offset shifts to the major
  // key sharing the same signature.
  return normalizeFifths(((key.root * 7) % 12) + MODE_FIFTHS_OFFSET[key.mode]);
}

/**
 * Computes the libsonare key (tonic + mode) for a key signature.
 *
 * @param keyFifths Key signature fifths (-7..7).
 * @param mode Audio `Mode` ordinal the signature should be read in
 *   (defaults to Major = 0).
 * @returns Tonic pitch class and mode; e.g. (0, Minor) -> A minor.
 */
export function keyFifthsToKey(keyFifths: number, mode: Mode = 0): Pick<Key, 'root' | 'mode'> {
  const majorFifths = keyFifths - MODE_FIFTHS_OFFSET[mode];
  const root = (((majorFifths * 7) % 12) + 12) % 12;
  return { root: root as Key['root'], mode };
}

/**
 * Converts an audio `Mode` ordinal (Major = 0) to the `ProjectKeySegment.mode`
 * encoding (0 = unknown, 1 = major, 2 = minor, ...).
 *
 * @param mode Audio `Mode` ordinal.
 * @returns The +1-shifted project annotation ordinal.
 */
export function modeToProjectMode(mode: Mode): number {
  return mode + 1;
}

/**
 * Converts a `ProjectKeySegment.mode` ordinal (0 = unknown, 1 = major, ...)
 * back to the audio `Mode` enum.
 *
 * @param projectMode Project annotation mode ordinal.
 * @returns The audio `Mode` ordinal, or undefined for unknown (0) or
 *   out-of-range values.
 */
export function projectModeToMode(projectMode: number): Mode | undefined {
  if (!Number.isInteger(projectMode) || projectMode < 1 || projectMode > 7) {
    return undefined;
  }
  return (projectMode - 1) as Mode;
}
