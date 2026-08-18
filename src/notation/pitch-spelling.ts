/**
 * Pitch spelling for the display-only notation pipeline.
 *
 * Converts MIDI note numbers to MusicXML-style spelled pitches
 * (step/alter/octave) using the key signature to choose between sharp and
 * flat spellings, and converts between MusicXML key fifths and libsonare
 * key descriptions.
 *
 * The diatonic letters of a key come from libcantus, so scales, chords and
 * engraved notes all name a scale degree the same way. What stays here is the
 * notation layer's own two rules: chromatic tones follow the side of the key
 * signature, and local melodic/harmonic context can override both.
 *
 * A melodic line is spelled as a whole by libcantus rather than note by note,
 * because the reading of one chromatic tone depends on the notes around it.
 */

import {
  isLibcantusError,
  isScaleTone,
  type NoteNameSystem,
  spellLine,
  spellPitchClass,
} from '@libraz/libcantus';
import { keyFifthsToSpelledKey } from '@/compose/key';
import { formatSpelledPitch } from '@/lib/pitch';
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

/**
 * Signature spelling when a pitch class is one of the key's seven scale tones.
 *
 * Delegated to libcantus so a scale degree carries the same letter here as in
 * chord and scale spelling; extreme signatures therefore keep E#/B# and Cb/Fb.
 * Chromatic pitch classes return undefined for the caller to spell.
 */
function signatureSpelling(
  pitchClass: number,
  fifths: number,
): Pick<SpelledPitch, 'step' | 'alter'> | undefined {
  const { tonic, key } = keyFifthsToSpelledKey(fifths);
  if (!isScaleTone(pitchClass, key)) return undefined;
  const note = spellPitchClass(pitchClass, tonic, key);
  return {
    step: STEPS[((note.letter % 7) + 7) % 7],
    alter: note.alter as SpelledPitch['alter'],
  };
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
export function spellPitchInKeySignature(midi: number, keyFifths: number): SpelledPitch {
  if (!Number.isInteger(midi) || midi < 0 || midi > 127) {
    throw new RangeError(`spellPitchInKeySignature: midi must be an integer in 0-127, got ${midi}`);
  }
  const pitchClass = midi % 12;
  // Engraving spells a chromatic tone on the side of the key signature, not by
  // its interval above the tonic: B natural in Bb major is B, never Cb.
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

/**
 * Whether a melodic motion is a written second, the only interval whose
 * direction dictates a spelling. A leap says nothing about which letter its
 * departure note takes, so treating one as a resolution is what makes a plain
 * D read as C## on the way up to F#.
 */
function isStepMotion(semitones: number): boolean {
  return semitones === 1 || semitones === 2;
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
 * signature. The plain {@link spellPitchInKeySignature} remains the stable
 * fallback for callers which only have a pitch class.
 *
 * Chord context spells a tone by its interval above the chord root, so a
 * seventh chord keeps its stacked thirds whatever the key signature says.
 * Melodic context only speaks for a written second: a chromatic tone stepping
 * to a natural neighbour takes the letter next to that neighbour (C#-D, not
 * Db-D). A whole melodic line is better spelled by
 * {@link spellLineInKeySignature}, which weighs each note against the entire
 * line rather than against one neighbour at a time.
 */
export function spellPitchWithContext(
  midi: number,
  keyFifths: number,
  context: PitchSpellingContext = {},
): SpelledPitch {
  const fallback = spellPitchInKeySignature(midi, keyFifths);
  const candidates = chromaticCandidates(midi);
  if (candidates.length === 1) return candidates[0];
  const rootMidi = context.chordRootMidi;
  const rootSpelling =
    rootMidi === undefined ? undefined : spellChordPitchClass(rootMidi % 12, keyFifths);
  const previous =
    context.previousMidi === undefined
      ? undefined
      : spellPitchInKeySignature(context.previousMidi, keyFifths);
  const next =
    context.nextMidi === undefined
      ? undefined
      : spellPitchInKeySignature(context.nextMidi, keyFifths);
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
      const motion = context.previousMidi - midi;
      const resolvesDownwardByStep =
        isStepMotion(motion) &&
        previous.alter === 0 &&
        ascendingStepDistance(candidate.step, previous.step) === 1;
      if (resolvesDownwardByStep) value += 4;
    }
    if (next !== undefined && context.nextMidi !== undefined) {
      const motion = context.nextMidi - midi;
      const resolvesUpwardByStep =
        isStepMotion(motion) &&
        next.alter === 0 &&
        ascendingStepDistance(candidate.step, next.step) === 1;
      if (resolvesUpwardByStep) value += 4;
    }
    return value;
  };
  return candidates.reduce((best, candidate) =>
    score(candidate) > score(best) ? candidate : best,
  );
}

/** Whether a spelling sits in the octave next to the one its pitch lives in. */
function crossesOctaveBoundary(pitch: Pick<SpelledPitch, 'step' | 'alter'>): boolean {
  return (pitch.step === 'C' && pitch.alter < 0) || (pitch.step === 'B' && pitch.alter > 0);
}

/**
 * Keeps a spelled note on the side of the key signature where reading it any
 * other way would move it into the neighbouring octave.
 *
 * Cb and B# are the only spellings whose staff position and octave number
 * belong to the octave next to the pitch they sound, so a B natural written
 * Cb5 is engraved above the C it stands below. A reader expects that only when
 * the key signature itself names the pitch that way, as Gb and Cb major name
 * Cb and C# major names B#. In every other key the notation layer's own rule
 * holds and the chromatic tone follows the signature's side, which is what
 * keeps a lower neighbour of C written as B.
 *
 * Line spelling is otherwise left alone: an interval is what tells a leap into
 * a borrowed chord to read Ab-C-Eb rather than G#-C-D#, and only these two
 * letters carry the octave cost.
 */
function keySignatureSide(pitch: SpelledPitch, midi: number, keyFifths: number): SpelledPitch {
  if (!crossesOctaveBoundary(pitch)) return pitch;
  const signature = spellPitchInKeySignature(midi, keyFifths);
  return crossesOctaveBoundary(signature) ? pitch : signature;
}

/** One sounding note of a melodic line, positioned in quarter-note beats. */
export interface LineNote {
  /** MIDI note number (integer 0-127). */
  midi: number;
  /** Onset in quarter-note beats from the start of the line's timeline. */
  startBeat: number;
  /** Sounding duration in quarter-note beats. */
  durationBeat: number;
}

/**
 * Spells a whole melodic line at once so its notes agree with each other.
 *
 * A chromatic tone cannot be read from its own pitch class: the same key
 * signature spells a rising run with sharps and a falling one with flats, and
 * one note taken alone has no direction. libcantus prices every spelling of
 * every note against the intervals its neighbours would then be written with
 * and takes the cheapest reading of the entire line, which is why the line has
 * to be handed over in one piece rather than a note or a measure at a time.
 *
 * No chord timeline is supplied: the notation pipeline has no harmonic
 * analysis at this point, and without one a chromatic chord simply falls back
 * to the key's own reading of its tones.
 *
 * @param line The notes of one voice, in time order.
 * @param keyFifths Key signature as MusicXML fifths (-7..7).
 * @returns One spelled pitch per input note, in input order.
 */
export function spellLineInKeySignature(
  line: readonly LineNote[],
  keyFifths: number,
): SpelledPitch[] {
  if (line.length === 0) return [];
  const { tonic, key } = keyFifthsToSpelledKey(keyFifths);
  try {
    const spelled = spellLine(
      line.map((note) => ({
        pitch: note.midi,
        startBeat: note.startBeat,
        durationBeat: note.durationBeat,
      })),
      null,
      key,
      { tonic },
    );
    return spelled.map((note, index) => {
      const step = STEPS[((note.letter % 7) + 7) % 7];
      const alter = note.alter as SpelledPitch['alter'];
      // The spelled octave already accounts for B#/Cb crossing the octave
      // boundary; it is only absent for a bare pitch class, which a line of
      // sounding notes never produces.
      const octave = note.octave ?? octaveForSpelling(line[index].midi, step, alter);
      return keySignatureSide({ step, alter, octave }, line[index].midi, keyFifths);
    });
  } catch (error) {
    // Score export must still produce a document when the line is longer than
    // the solver's budget or carries a pitch it rejects; spelling every note
    // from the key signature alone loses the melodic reading, nothing else.
    if (!isLibcantusError(error)) throw error;
    return line.map((note) => spellPitchInKeySignature(note.midi, keyFifths));
  }
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

/**
 * Formats a chord pitch class as a display token such as `Bb` or `F#`.
 *
 * The default English naming is what the score, MusicXML export and every
 * other chord-symbol text use; a caller naming another system is displaying
 * the root to a reader, not writing a document.
 *
 * @param pitchClass Pitch class 0..11 (C = 0).
 * @param keyFifths MusicXML key-signature fifths the spelling follows.
 * @param system Note-name system; English by default.
 */
export function chordPitchClassName(
  pitchClass: number,
  keyFifths: number,
  system: NoteNameSystem = 'english',
): string {
  const spelled = spellChordPitchClass(pitchClass, keyFifths);
  if (system !== 'english') return formatSpelledPitch(spelled, system);
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
