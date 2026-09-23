/**
 * Piano-roll composition guidance: per-chord-segment pitch-class safety tints
 * and per-note theory analysis for the active clip.
 *
 * Combines the compose adapters (key, chord timeline, meter, track hygiene)
 * with libcantus's safety/role/voice analysis into one deterministic pass.
 * Percussion tracks are dropped from the voice context before any safety
 * evaluation (see {@link harmonicTracksOnly}) so drum hits never register as
 * false dissonance against the melody.
 *
 * Pure module (no Vue/Pinia); libcantus calls are guarded so unexpected input
 * degrades to a partial analysis instead of throwing at the caller.
 */

import {
  type AnalyzedNote,
  analyzeVoice,
  type ChordData,
  ConsonanceClass,
  chordScaleReport,
  classifyInterval,
  createsBattuta,
  createsHiddenParallelPerfect,
  createsParallelPerfect,
  evaluateSafety,
  exceedsSpacing,
  isForbiddenMelodicLeap,
  isLeadingToneResolution,
  isScaleTone,
  type NoteData,
  NoteSafety,
  pitchToScaleDegree,
  ReasonFlag,
  roleOf,
  type SafetyProfile,
  type SafetyResult,
  type VoicedRole,
  type VoiceNote,
  type VoiceSnapshot,
} from '@libraz/libcantus';
import { type SpelledPitch, spellLineInKeySignature } from '@/notation/pitch-spelling';
import type { EditorChordSymbol } from '@/project/chords';
import { meterBarLengthPpq, timeSignatureAt } from '@/project/time-signature';
import type { EditorNote, ScaleHighlightConfig, TimeSignatureSegment } from '@/project/types';
import { buildChordTimeline } from './chord-at-tick';
import { effectiveKeyScale, keyScaleToKeyFifths } from './key';
import { strongBeatAt } from './meter';
import { cadenceArrivals, cadencesByNote, type NoteCadence } from './note-cadences';
import { editorNotesToNoteEvents } from './notes-io';
import { harmonicTracksOnly, type TrackWithNotes } from './tracks';
import { buildVoiceContext, keySpeller, motionFindings, type OuterVoice } from './voice-context';

/** Representative octave anchor: pitch class pc is evaluated as MIDI 60 + pc. */
const CENTER_C = 60;

/**
 * Scale fits kept per chord: the best one names the chord scale, the rest are
 * offered as runners-up. Few enough that the card stays readable.
 */
const CHORD_SCALES_REPORTED = 3;

export interface GuidanceInput {
  /** Active clip notes (clip-relative PPQ). */
  notes: ReadonlyArray<EditorNote>;
  /** Active clip timeline start in PPQ (to reach absolute beats). */
  clipStartPpq: number;
  /** Full active clip window length in PPQ, including empty space. */
  clipLengthPpq: number;
  /**
   * Clip trim offset (the source PPQ shown at the clip's left edge). Emitted
   * segment beats are shifted by it so they land in the clip's source-relative
   * frame — the frame the note-editing surfaces draw notes in — rather than a
   * window-relative one, keeping tints aligned on a trimmed clip. Defaults to 0.
   */
  sourceOffsetPpq?: number;
  /** Project chord track (absolute PPQ regions); empty = no progression. */
  chordSymbols: ReadonlyArray<EditorChordSymbol>;
  /** Store scale-highlight config (key context). */
  key: ScaleHighlightConfig;
  /** Project meter map. */
  timeSignatures: ReadonlyArray<TimeSignatureSegment>;
  /** Safety severity policy (default 'pop'). */
  profile?: 'strict' | 'pop';
  /**
   * Other tracks for voice context (percussion excluded internally). Their
   * notes must carry absolute timeline PPQ (clip offsets already applied);
   * notes shared with the active clip (same id) are ignored.
   */
  otherTracks?: ReadonlyArray<TrackWithNotes>;
}

/** Per chord segment: safety of each pitch class, for background row tint. */
export interface GuidanceSegment {
  /**
   * Source-relative beat span the segment covers (for drawing on the grid): 0
   * is the clip's source origin, matching the note-editing surfaces' PPQ, so a
   * trimmed clip's tints still line up under its notes.
   */
  startBeat: number;
  endBeat: number;
  /** NoteSafety (0/1/2) per pitch class 0..11 for a placed note there. */
  safetyByPc: Uint8Array;
}

/** The best-fitting scale over the sounding chord, with its color/avoid tones. */
export interface ChordScaleInfo {
  /** Scale name (a key of libcantus NAMED_SCALES, e.g. 'ionian'). */
  scaleName: string;
  /** Pitch class the scale is rooted on (the chord root). */
  rootPc: number;
  /** Available-tension pitch classes (usable color tones) over the chord. */
  tensions: number[];
  /** Pitch classes a line may pass through melodically but not sound on. */
  passing: number[];
  /** Avoid-note pitch classes over the chord (not to be played at all). */
  avoid: number[];
  /**
   * Runner-up scale names, next-best fit first. Same root as {@link scaleName},
   * since the chord-scale relationship only roots scales on the chord root.
   */
  alternates?: string[];
}

/**
 * The vertical (voice-relative) reading of a note against the sounding
 * counterpoint: its interval to the lowest concurrent voice and that interval's
 * consonance class. Chord-independent, so it describes polyphony that carries no
 * chord progression (e.g. Baroque counterpoint). Absent when the note is the
 * lowest sounding voice or sounds alone.
 */
export interface VerticalInfo {
  /** Semitone interval up from the lowest concurrent voice (the bass). */
  toBass: number;
  /** Consonance class of that interval. */
  consonance: 'perfect' | 'imperfect' | 'dissonant';
}

/**
 * Counterpoint readings taken from libcantus's predicate suite rather than from
 * the safety verdict's reason bitfield, which names only four events
 * (suspension, parallel perfect, hidden parallel, voice crossing).
 *
 * All three are measured across one step of the active voice — this note and
 * the voice's previous onset — so each describes the motion *into* the note the
 * card is on, which is the note the reader is pointing at. Absent fields mean
 * the reading did not fire, so a note carrying none of them carries no object.
 */
export interface CounterpointFindings {
  /**
   * The step into this note is a leap strict counterpoint forbids: a seventh,
   * an augmented or diminished interval, or a leap wider than an octave.
   */
  forbiddenLeap?: boolean;
  /**
   * The previous note was the leading tone and this note is the tonic it
   * resolved up to. The one positive reading in the set; every other
   * counterpoint verdict the card can show names a fault.
   */
  leadingToneResolution?: boolean;
  /**
   * This note completes an *ottava battuta* against another voice: a perfect
   * octave or unison reached by contrary motion with the upper of the two
   * voices leaping down onto it.
   */
  battuta?: boolean;
  /**
   * More than an octave separates this note from the voice next to it in the
   * texture. Alone in this set it is a standing fact about one instant rather
   * than a reading of the step into the note, so it needs neither a previous
   * note nor a spelling.
   *
   * The pair it reports is adjacent by sounding pitch, and never the bottom
   * one: an octave-and-a-half between the bass and everything above it is how
   * most music is scored, so measuring it reports the instrumentation instead
   * of the writing.
   */
  wideSpacing?: boolean;
}

/** Per-note theory analysis (keyed by EditorNote.id in the result map). */
export interface NoteAnalysis {
  safety?: SafetyResult;
  role?: VoicedRole;
  analyzed?: AnalyzedNote;
  /** Scale degree of the note in the key, counted from 1 (-1 off the scale). */
  degree: number;
  isScaleTone: boolean;
  /**
   * Whether a chord of the progression sounds at the note's onset.
   *
   * Harmonic safety is only meaningful against a chord: with none, libcantus
   * never answers Safe (a scale tone comes back Warning, anything else
   * Dissonant), so the verdict would report a clash with a chord that is not
   * there. The card gates its safety line on this. The verdict itself is still
   * computed, because what it carries besides the severity — the counterpoint
   * reasons and the `resolveTo` target — is chord-independent.
   */
  chordSounding: boolean;
  /** Best-fit scale and its color/avoid tones for the sounding chord, if any. */
  chordScale?: ChordScaleInfo;
  /**
   * Interval and consonance against the concurrent voices' bass. Drives the
   * card's contrapuntal line; the voice-relative counterpoint verdicts
   * (suspension, parallels, voice crossing) ride the {@link safety} reasons
   * bitfield, which {@link buildGuidance} now feeds voice motion so they fire
   * without any chord present.
   */
  vertical?: VerticalInfo;
  /**
   * Counterpoint readings the safety verdict does not carry, present only when
   * at least one of them fired. Chord-independent like the verdict's own
   * reasons, so they describe polyphony that carries no progression.
   */
  counterpoint?: CounterpointFindings;
  /**
   * The cadence this note arrives on, when it is one of the notes sounding the
   * arrival. Present only at the arrival itself, never across the resolving
   * chord's span, and only where the harmony is trustworthy enough to name one
   * — see {@link cadenceArrivals}.
   */
  cadence?: NoteCadence;
  /**
   * How the note is written on a staff: the same reading the score and the
   * MusicXML export engrave it with, so a surface naming the note to a reader
   * (the hover card's title) cannot contradict the notehead the reader is
   * looking at. Absent when no key is set, since the spelling is a claim about
   * a key and the surfaces name pitch classes plainly without one.
   *
   * Deliberately not the spelling the counterpoint findings above are measured
   * from: those count intervals from the tonic, which is a different question
   * and gives a different letter for the same pitch (see the spelling note in
   * {@link buildGuidance}). This one is never handed to a predicate.
   */
  engraved?: SpelledPitch;
}

export interface GuidanceResult {
  /** Background tint segments in clip-relative beats. */
  segments: GuidanceSegment[];
  /** Analysis per active-clip note id. */
  byNoteId: Map<number, NoteAnalysis>;
  /** Whether a key was set (highlight enabled). */
  keySet: boolean;
  /**
   * Whether any chord covered the clip window, which is what decides how the
   * background tint is emitted. A progression can leave gaps, so per-note
   * questions ("does a chord sound under this note?") read
   * {@link NoteAnalysis.chordSounding} instead.
   */
  chordPresent: boolean;
}

/**
 * The pitch a note is expected to resolve to, from its analyzer labels
 * (suspension, needs-resolution, leading-tone all carry a `resolveTo` target),
 * or undefined when the note carries no resolution obligation. When no chord-
 * based label applies, the voice-relative safety verdict's `resolveTo` is used
 * so a suspension detected purely from the surrounding voices still draws its
 * resolution arrow.
 */
export function resolutionTargetOf(analysis: NoteAnalysis): number | undefined {
  for (const label of analysis.analyzed?.labels ?? []) {
    if ('resolveTo' in label && typeof label.resolveTo === 'number') return label.resolveTo;
  }
  return analysis.safety?.resolveTo;
}

/** Runs a libcantus call that may throw; undefined signals "no result". */
function tryEval<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * Safety verdict per pitch class for one chord context, each pitch class
 * evaluated as its representative pitch in the central octave [60, 71].
 * A failed evaluation degrades to Safe (no tint) rather than a false alarm.
 */
function safetyRow(
  chord: ChordData | null,
  key: ReturnType<typeof effectiveKeyScale>,
  profile: SafetyProfile,
  strongBeat: boolean,
): Uint8Array {
  const row = new Uint8Array(12);
  for (let pc = 0; pc < 12; pc++) {
    const result = tryEval(() =>
      evaluateSafety({
        profile,
        candidatePitch: CENTER_C + pc,
        chord,
        key,
        otherVoices: [],
        strongBeat,
      }),
    );
    row[pc] = result?.safety ?? NoteSafety.Safe;
  }
  return row;
}

/**
 * Builds the full guidance for one active clip: background tint segments per
 * sounding chord and meter pulse, plus a per-note theory analysis map.
 */
export function buildGuidance(input: GuidanceInput): GuidanceResult {
  const profile: SafetyProfile = input.profile ?? 'pop';
  const key = effectiveKeyScale(input.key);
  const keySet = input.key.enabled;
  const timeline = buildChordTimeline(input.chordSymbols);

  // Tint the explicit clip window, not merely the span occupied by notes.
  // This keeps long empty tails and entirely empty clips analyzable.
  const windowStart = input.clipStartPpq;
  const windowEnd = windowStart + Math.max(0, input.clipLengthPpq);

  // Voice context: one line per non-percussion other track, kept separate (not
  // pooled) so each voice's motion can be tracked across time. That per-voice
  // motion is what the counterpoint verdicts (parallels, hidden parallels,
  // voice crossing, suspension) read — none of which need a chord. Each track
  // is reduced to its highest sounding pitch at a beat as that voice's
  // representative, so a residually polyphonic track still contributes an outer
  // voice rather than an ambiguous cluster.
  // Per-note analysis is time ordered. Its unique onsets are also the only
  // instants at which counterpoint context is queried, so index other voices
  // against that small, relevant time domain instead of rescanning every
  // project note for every active note. That same grid of slots carries the
  // history a parallel has to be read against (see {@link DOUBLING_RUN_SLOTS}),
  // which is why the indexes below are built once for the whole pass.
  const sorted = [...input.notes].sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch);
  const voiceQueryBeats = [
    ...new Set(sorted.map((note) => input.clipStartPpq + note.startPpq)),
  ].sort((a, b) => a - b);
  const activeIds = new Set(input.notes.map((note) => note.id));
  const otherVoiceLines: EditorNote[][] = [];
  if (input.otherTracks !== undefined) {
    const { harmonic } = harmonicTracksOnly(input.otherTracks);
    for (const item of harmonic) {
      const line = item.notes.filter((note) => !activeIds.has(note.id));
      if (line.length > 0) otherVoiceLines.push(line);
    }
  }
  // A line's position stands in for its track id so two inputs sharing an id
  // stay two voices.
  const otherVoices = buildVoiceContext(
    otherVoiceLines.map((notes, index) => ({ trackId: index, role: 'melodic', notes })),
    voiceQueryBeats,
    input.timeSignatures,
  );
  /**
   * Each other line's top voice at `absBeat`, carrying its top at `prevBeat`
   * when given. Unlike `outerVoicesAt` with a previous beat, the pitch there is
   * not bar-bounded: evaluateSafety measures the step unbounded, and the bar
   * bound belongs to the dismissals below.
   */
  const topVoicesAt = (absBeat: number, prevBeat?: number): OuterVoice[] => {
    const tops = otherVoices.outerVoicesAt(absBeat, undefined).filter((v) => v.edge === 'top');
    if (prevBeat === undefined) return tops;
    const prevTops = new Map(
      otherVoices
        .outerVoicesAt(prevBeat, undefined)
        .filter((v) => v.edge === 'top')
        .map((v) => [v.trackId, v.pitch]),
    );
    return tops.map((voice) => {
      const prevPitch = prevTops.get(voice.trackId);
      return prevPitch !== undefined ? { ...voice, prevPitch } : voice;
    });
  };
  /**
   * Snapshot of every voice sounding at `absBeat`, each carrying its pitch at
   * `prevBeat` when given so evaluateSafety can measure motion between the two
   * events. Voices silent at `absBeat` are omitted.
   */
  const othersAt = (absBeat: number, prevBeat?: number): VoiceSnapshot[] =>
    topVoicesAt(absBeat, prevBeat).map(({ pitch, prevPitch }) =>
      prevPitch !== undefined ? { pitch, prevPitch } : { pitch },
    );
  /** Interval to the bass (lowest concurrent voice) for the card, if audible. */
  const verticalAt = (pitch: number, others: VoiceSnapshot[]): VerticalInfo | undefined => {
    let bass: number | undefined;
    for (const voice of others)
      bass = bass === undefined ? voice.pitch : Math.min(bass, voice.pitch);
    if (bass === undefined || bass >= pitch) return undefined;
    const semitones = pitch - bass;
    // This is explicitly the interval *to the bass*. A perfect fourth above
    // the bass is dissonant regardless of how many other voices are present.
    const consonanceClass = tryEval(() => classifyInterval(semitones, true));
    const consonance =
      consonanceClass === ConsonanceClass.PerfectConsonance
        ? 'perfect'
        : consonanceClass === ConsonanceClass.ImperfectConsonance
          ? 'imperfect'
          : 'dissonant';
    return { toBass: semitones, consonance };
  };
  /**
   * The texture at `absBeat` ordered low to high: the candidate note and every
   * other voice sounding with it, the same reduction the readings above take.
   *
   * Two of the counterpoint rules are about *which* pair of voices is being
   * asked about rather than about what a pair does, and neither question can be
   * answered from a pair alone — the outer voices and the voice next to you are
   * both facts about everything else sounding. The library provides the
   * predicates and leaves the choice of pair to the caller, which is this.
   */
  const soundingWith = (pitch: number, absBeat: number): number[] =>
    [pitch, ...topVoicesAt(absBeat).map((voice) => voice.pitch)].sort((a, b) => a - b);
  /**
   * Whether more than an octave separates the candidate from the voice next to
   * it in the texture.
   *
   * Only adjacent pairs are asked, and never the bottom one: bass-to-tenor
   * spacing is conventionally exempt, and a melody carried an eleventh above a
   * bass line — which is most homophony — otherwise reports a fault on every
   * note it has. With two voices sounding, the only pair is that exempt one.
   */
  const wideSpacingAt = (pitch: number, absBeat: number): boolean => {
    const sounding = soundingWith(pitch, absBeat);
    for (let index = 1; index + 1 < sounding.length; index++) {
      const lower = sounding[index];
      const upper = sounding[index + 1];
      if (lower !== pitch && upper !== pitch) continue;
      if (exceedsSpacing(upper, lower)) return true;
    }
    return false;
  };

  // The active clip read as one voice on the same slot grid, so its line can be
  // followed against another voice's the way the others are followed against
  // it: same top-of-the-texture reduction, same instants.
  const activeVoice = buildVoiceContext(
    [
      {
        trackId: 0,
        role: 'melodic',
        notes: input.notes.map((note) => ({
          ...note,
          startPpq: input.clipStartPpq + note.startPpq,
        })),
      },
    ],
    voiceQueryBeats,
    input.timeSignatures,
  );
  const activeTopAt = (beat: number): number | undefined =>
    activeVoice.outerVoicesAt(beat, undefined)[0]?.pitch;
  const slotOfBeat = new Map(voiceQueryBeats.map((beat, slot) => [beat, slot]));
  /**
   * Per other voice, the length of the unbroken run of slots holding one
   * constant separation from the active voice that each slot belongs to. A
   * separation neither voice defines (one of them silent) breaks the run, which
   * is what the NaN comparison below does. Computed in one sweep per voice so
   * reading a note's run is a lookup.
   */
  const otherTopsBySlot = voiceQueryBeats.map(
    (beat) => new Map(topVoicesAt(beat).map((voice) => [voice.trackId, voice.pitch])),
  );
  const doublingRuns = otherVoiceLines.map((_, voice) => {
    const runs = new Int32Array(voiceQueryBeats.length);
    let runStart = 0;
    let held = Number.NaN;
    for (let slot = 0; slot <= voiceQueryBeats.length; slot++) {
      const beat = voiceQueryBeats[slot];
      const top = beat !== undefined ? activeTopAt(beat) : undefined;
      const other = beat !== undefined ? otherTopsBySlot[slot].get(voice) : undefined;
      const separation = top !== undefined && other !== undefined ? top - other : Number.NaN;
      if (separation === held) continue;
      for (let filled = runStart; filled < slot; filled++) runs[filled] = slot - runStart;
      runStart = slot;
      held = separation;
    }
    return runs;
  });
  /**
   * The counterpoint predicates read spelled notes: an augmented second and a
   * minor third span the same three semitones, and a diminished fourth sounds
   * like a major third, so a bare MIDI pair cannot state the question they ask.
   * Given integers they silently fall back to the sounding reading and let
   * every augmented interval through.
   *
   * The spelling is decided from the project key — the same key the hover card
   * spells its pitch names from, since the card's `keyFifths` is derived from
   * this very scale-highlight config — so the card cannot name a note against
   * one key and analyse it against another. That choice is a real one and not a
   * detail: reading D minor commits the piece to Bb rather than A#, and it is
   * exactly that commitment which makes the step up to C# an augmented second.
   *
   * What the analysis does not borrow is the *engraving* rule the card's title
   * spells with, which puts a chromatic tone on the side of the key signature
   * so a lower neighbour of C stays written as B. That is right for a staff and
   * wrong for an interval: it spells D minor's C# as Db, and then the same D
   * minor line reads full of diminished fourths that nobody wrote. The
   * interval spelling counted from the tonic is what these predicates are
   * asking about, so it is what they are given.
   */
  const spell = keySpeller(key);
  /**
   * Key-only spelling, memoized per pitch. Used for the other voices, whose
   * notes are only ever compared by perfect class — a comparison no spelling
   * changes — so they need a valid spelling rather than the best one, and MIDI's
   * 128 pitches make the cache bounded.
   */
  const keySpellings = new Map<number, NoteData | undefined>();
  const spellFromKey = (pitch: number): NoteData | undefined => {
    let spelled = keySpellings.get(pitch);
    if (spelled === undefined && !keySpellings.has(pitch)) {
      spelled = spell(pitch);
      keySpellings.set(pitch, spelled);
    }
    return spelled;
  };
  /**
   * The staff reading of the clip's own notes, solved as one line: the spelling
   * the score and the MusicXML export engrave with, carried on the analysis so
   * the hover card names a note the way its notehead is written.
   *
   * A line can only be spelled whole — which letter a chromatic tone takes is
   * decided by the notes around it — so this is computed once per pass rather
   * than per hover, where re-solving the entire clip on every mouse move would
   * buy nothing: the answer cannot change between two hovers of the same clip.
   *
   * The clip goes over as a single line, the same reduction the melodic label
   * pass below makes of it. The notation layer splits a part into notated
   * voices before spelling it, but a clip is one editable part and carries no
   * such split, so there is nothing here to split it by.
   *
   * The signature is the project key's own, which is how the surfaces reach it
   * too, so the card's title and the staff answer from one key signature.
   */
  const engravedByNoteId = new Map<number, SpelledPitch>();
  if (keySet) {
    const engraved = spellLineInKeySignature(
      sorted.map((note) => ({
        midi: note.pitch,
        startBeat: input.clipStartPpq + note.startPpq,
        durationBeat: note.durationPpq,
      })),
      keyScaleToKeyFifths(key),
    );
    sorted.forEach((note, index) => {
      engravedByNoteId.set(note.id, engraved[index]);
    });
  }
  /**
   * Whether the library's parallel-perfect verdict on a candidate describes a
   * voice-leading event the composer can act on.
   *
   * `evaluateSafety` reports one bit for the whole note, so the pairs that
   * earned it are reconstructed here with the library's own predicate — the
   * verdict stands unless every one of them is dismissed, and a pair the
   * reconstruction cannot account for keeps it.
   */
  const parallelPerfectIsReal = (
    pitch: number,
    prevPitch: number | undefined,
    absBeat: number,
    prevAbs: number | undefined,
  ): boolean => {
    if (prevPitch === undefined || prevAbs === undefined) return true;
    // A parallel is motion measured across one step of the voice, and the step
    // is whatever this part last played — after a rest that can be bars back.
    // Past the bar in force the two events are no longer heard as consecutive,
    // so the interval they share is a coincidence rather than a progression.
    const bar = meterBarLengthPpq(timeSignatureAt(input.timeSignatures, absBeat));
    if (absBeat - prevAbs > bar) return false;
    const slot = slotOfBeat.get(absBeat);
    // A run describes the voice pair, so it may only answer for the note that
    // is the active voice at that instant — a cluster's inner note is not it.
    const isActiveVoice = activeTopAt(absBeat) === pitch;
    const others = topVoicesAt(absBeat, prevAbs);
    const fired = others.some(
      (other) =>
        other.prevPitch !== undefined &&
        createsParallelPerfect(prevPitch, pitch, other.prevPitch, other.pitch),
    );
    if (!fired) return true;
    // The runs here span the whole slot run, so the earlier slots are the run
    // minus the candidate's own.
    const { parallelPerfect } = motionFindings(pitch, prevPitch, others, (other) =>
      isActiveVoice && slot !== undefined ? doublingRuns[other.trackId][slot] - 1 : 0,
    );
    return parallelPerfect.length > 0;
  };
  /**
   * Whether the library's hidden-parallel verdict on a candidate describes a
   * voice-leading event the composer can act on.
   *
   * The library already applies the traditional step exception, so every
   * verdict here is a perfect interval entered by similar motion with the upper
   * voice leaping. What it cannot apply is the other half of the rule: a direct
   * fifth or octave is a fault *between the outer voices*, and the same motion
   * buried between two inner parts is what four-part writing accepts. Selecting
   * that pair needs the whole texture, which only the caller has — and asking
   * every pair of a four-voice texture instead reports faults in writing that
   * has none: a plain chorale with textbook spacing comes back with three.
   *
   * Reconstruction and dismissal follow the parallel reading above: the pairs
   * that earned the bit are found with the library's own predicate, the verdict
   * stands unless every one of them is dismissed, and a pair that cannot be
   * accounted for keeps it. The bar bound is the same too, and for the same
   * reason — across a longer gap than that, the two events are not heard as one
   * voice moving.
   */
  const hiddenParallelIsReal = (
    pitch: number,
    prevPitch: number | undefined,
    absBeat: number,
    prevAbs: number | undefined,
  ): boolean => {
    if (prevPitch === undefined || prevAbs === undefined) return true;
    const bar = meterBarLengthPpq(timeSignatureAt(input.timeSignatures, absBeat));
    if (absBeat - prevAbs > bar) return false;
    const others = topVoicesAt(absBeat, prevAbs);
    const fired = others.some(
      (other) =>
        other.prevPitch !== undefined &&
        createsHiddenParallelPerfect(prevPitch, pitch, other.prevPitch, other.pitch),
    );
    return !fired || motionFindings(pitch, prevPitch, others, () => 0).hiddenOuter;
  };
  /**
   * Whether the candidate completes an *ottava battuta* against any other
   * voice: a perfect octave or unison reached by contrary motion with the upper
   * of the two voices leaping down onto it.
   *
   * It reuses the pair machinery above and the same two instants, but none of
   * the parallel suppression: that reading dismisses contrary-motion pairs
   * because contrary motion is not parallel motion, and contrary motion is
   * precisely what this rule is about. The two rules name different events and
   * are therefore gated separately.
   */
  const battutaWithOthers = (
    spelled: NoteData,
    prevSpelled: NoteData,
    pitch: number,
    prevPitch: number,
    absBeat: number,
    prevAbs: number,
  ): boolean => {
    for (const { pitch: other, prevPitch: otherPrev } of topVoicesAt(absBeat, prevAbs)) {
      if (otherPrev === undefined) continue;
      const otherSpelled = spellFromKey(other);
      const otherPrevSpelled = spellFromKey(otherPrev);
      if (otherSpelled === undefined || otherPrevSpelled === undefined) continue;
      // Which voice is the upper one is decided where the pair arrives, since
      // that is the interval the rule is about. On a unison arrival the two land
      // on the same pitch and say nothing, so the step they took decides.
      const candidateIsUpper = pitch === other ? prevPitch > otherPrev : pitch > other;
      const fired = candidateIsUpper
        ? tryEval(() => createsBattuta(prevSpelled, spelled, otherPrevSpelled, otherSpelled))
        : tryEval(() => createsBattuta(otherPrevSpelled, otherSpelled, prevSpelled, spelled));
      if (fired === true) return true;
    }
    return false;
  };

  // Without a chord, keep the one window segment the UI uses for its grid but
  // mark every pitch class Safe: harmonic safety has no context to evaluate.
  const overlapping = timeline.segments.filter(
    (segment) => segment.endBeat > windowStart && segment.startBeat < windowEnd,
  );
  const chordPresent = overlapping.length > 0;
  // Segment beats are emitted in the clip's source frame: window-relative
  // (position − clipStart) plus the trim offset shown at the clip's left edge.
  const sourceOffset = input.sourceOffsetPpq ?? 0;
  const segments: GuidanceSegment[] = [];
  if (chordPresent) {
    for (const segment of overlapping) {
      const absStart = Math.max(segment.startBeat, windowStart);
      const absEnd = Math.min(segment.endBeat, windowEnd);
      // A chord can span several strong and weak metric positions. Split it at
      // the active meter's beat unit so background tint uses the same context
      // as the per-note analysis rather than inheriting the chord's first beat.
      for (let cursor = absStart; cursor < absEnd - 1e-6; ) {
        const meter = timeSignatureAt(input.timeSignatures, cursor);
        const meterUnitPpq = 4 / meter.denominator;
        const end = Math.min(absEnd, cursor + meterUnitPpq);
        segments.push({
          startBeat: cursor - input.clipStartPpq + sourceOffset,
          endBeat: end - input.clipStartPpq + sourceOffset,
          safetyByPc: safetyRow(
            segment.chord,
            key,
            profile,
            strongBeatAt(input.timeSignatures, cursor),
          ),
        });
        cursor = end;
      }
    }
  } else {
    segments.push({
      startBeat: sourceOffset,
      endBeat: windowEnd - windowStart + sourceOffset,
      safetyByPc: new Uint8Array(12),
    });
  }

  // Cadences are a property of the whole texture, not of the part being edited,
  // so the harmony is read over every sounding voice: the active clip's notes on
  // the shared timeline plus the other (non-percussion, non-duplicated) lines
  // already gathered for the counterpoint context. Reading them costs nothing
  // when a chord track states the progression, so the notes are only pooled when
  // there is none to state it.
  const cadenceNotes =
    input.chordSymbols.length > 0
      ? []
      : [
          ...editorNotesToNoteEvents(input.notes, input.clipStartPpq),
          ...otherVoiceLines.flatMap((line) => editorNotesToNoteEvents(line)),
        ].sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);
  const cadences = cadenceArrivals(input.chordSymbols, cadenceNotes, key, input.timeSignatures);
  const cadenceByNoteId = cadencesByNote(
    input.notes,
    (note) => input.clipStartPpq + note.startPpq,
    cadences.arrivals,
    cadences.inferred,
    input.timeSignatures,
  );

  // Per-note analysis, in time order so prevPitch reflects the preceding
  // onset group (cluster members never count each other as "previous").
  const byNoteId = new Map<number, NoteAnalysis>();
  // Chord-scale reports are chord-only, so memoize by chord identity to avoid
  // recomputing the scale fit for every note under the same chord.
  const chordScaleCache = new Map<string, ChordScaleInfo | undefined>();
  const chordScaleFor = (chord: ChordData): ChordScaleInfo | undefined => {
    const identity = `${chord.rootPc}:${chord.quality}:${chord.intervals.join(',')}:${chord.bassPc ?? -1}`;
    const cached = chordScaleCache.get(identity);
    if (cached !== undefined || chordScaleCache.has(identity)) return cached;
    const report = tryEval(() => chordScaleReport(chord, CHORD_SCALES_REPORTED));
    const best = report?.[0];
    const alternates = (report ?? []).slice(1).map((entry) => entry.name);
    const info: ChordScaleInfo | undefined =
      best !== undefined
        ? {
            scaleName: best.name,
            rootPc: best.rootPc,
            tensions: best.tensions,
            passing: best.passing,
            avoid: best.avoid,
            ...(alternates.length > 0 ? { alternates } : {}),
          }
        : undefined;
    chordScaleCache.set(identity, info);
    return info;
  };
  /**
   * The onset group following each onset, by its representative (highest)
   * pitch. A chromatic note is spelled by where it goes as well as by where it
   * came from — the C# rising to D is a leading tone, the Db falling to C an
   * inflection — so the melodic reading needs one note of lookahead, which the
   * time-ordered walk below does not otherwise have.
   */
  const groupPitchByOnset = new Map<number, number>();
  for (const note of sorted) groupPitchByOnset.set(note.startPpq, note.pitch);
  const onsets = [...groupPitchByOnset.keys()];
  const nextGroupPitchByOnset = new Map<number, number>();
  for (let index = 0; index + 1 < onsets.length; index++) {
    const next = groupPitchByOnset.get(onsets[index + 1]);
    if (next !== undefined) nextGroupPitchByOnset.set(onsets[index], next);
  }
  let prevGroupPitch: number | undefined;
  let prevGroupSpelled: NoteData | undefined;
  let prevGroupOnset: number | undefined;
  let lastPitch: number | undefined;
  let lastSpelled: NoteData | undefined;
  let groupOnset = Number.NaN;
  for (const note of sorted) {
    if (note.startPpq !== groupOnset) {
      if (!Number.isNaN(groupOnset)) prevGroupOnset = groupOnset;
      if (lastPitch !== undefined) {
        prevGroupPitch = lastPitch;
        prevGroupSpelled = lastSpelled;
      }
      groupOnset = note.startPpq;
    }
    const absBeat = input.clipStartPpq + note.startPpq;
    // Absolute beat of this voice's previous onset group, so other voices are
    // sampled at the same two instants the candidate moves between (a parallel
    // is motion measured across one step of the reference voice).
    const prevAbs = prevGroupOnset !== undefined ? input.clipStartPpq + prevGroupOnset : undefined;
    const chord = timeline.at(absBeat);
    const analysis: NoteAnalysis = {
      degree: pitchToScaleDegree(note.pitch, key),
      isScaleTone: isScaleTone(note.pitch, key),
      chordSounding: chord !== null,
    };
    const engraved = engravedByNoteId.get(note.id);
    if (engraved !== undefined) analysis.engraved = engraved;
    if (chord !== null) {
      const role = tryEval(() => roleOf(note.pitch, chord));
      if (role !== undefined) analysis.role = role;
      const chordScale = chordScaleFor(chord);
      if (chordScale !== undefined) analysis.chordScale = chordScale;
    }
    const others = othersAt(absBeat, prevAbs);
    const vertical = verticalAt(note.pitch, others);
    if (vertical !== undefined) analysis.vertical = vertical;
    const cadence = cadenceByNoteId.get(note.id);
    if (cadence !== undefined) analysis.cadence = cadence;
    const prevPitch = prevGroupPitch;
    const safety = tryEval(() =>
      evaluateSafety({
        profile,
        candidatePitch: note.pitch,
        prevPitch,
        chord,
        key,
        otherVoices: others,
        strongBeat: strongBeatAt(input.timeSignatures, absBeat),
      }),
    );
    // The two motion-into-a-perfect-interval reasons are dismissed here rather
    // than where the card is written: the verdict is the analysis every surface
    // reads, so a reason that does not describe the music has no business
    // travelling on it. Only those bits are cleared — the vertical dissonance,
    // suspension and voice-crossing readings, and the `resolveTo` target the
    // resolution arrows follow, are the library's answers untouched. The
    // severity stays as scored too: it is the worst of every reason weighed
    // together, which cannot be re-derived from outside, and it is only ever
    // shown against a chord.
    if (safety !== undefined) {
      let cleared = 0;
      if (
        (safety.reasons & ReasonFlag.ParallelPerfect) !== 0 &&
        !parallelPerfectIsReal(note.pitch, prevPitch, absBeat, prevAbs)
      ) {
        cleared |= ReasonFlag.ParallelPerfect;
      }
      if (
        (safety.reasons & ReasonFlag.HiddenParallel) !== 0 &&
        !hiddenParallelIsReal(note.pitch, prevPitch, absBeat, prevAbs)
      ) {
        cleared |= ReasonFlag.HiddenParallel;
      }
      analysis.safety = cleared === 0 ? safety : { ...safety, reasons: safety.reasons & ~cleared };
    }
    // The readings the verdict's four reason bits do not carry. They are
    // measured across the same step of the voice the verdict is measured across
    // — this note and the previous onset group, unbounded, exactly as
    // evaluateSafety is handed it above — so the card never reports a motion
    // the two halves of the analysis disagreed about. The bar-length bound
    // belongs to the *dismissals* above rather than to the step itself, which is
    // why it is not repeated here.
    const nextPitch = nextGroupPitchByOnset.get(note.startPpq);
    const spelled = spell(note.pitch, {
      ...(prevPitch !== undefined ? { previous: prevPitch } : {}),
      ...(nextPitch !== undefined ? { next: nextPitch } : {}),
    });
    const findings: CounterpointFindings = {};
    // Spacing stands outside the guard below: it reads one instant rather than
    // a step between two, so it holds for the clip's first note as well, and
    // the pitches it compares are sounding ones that need no spelling.
    if (wideSpacingAt(note.pitch, absBeat)) findings.wideSpacing = true;
    if (
      spelled !== undefined &&
      prevGroupSpelled !== undefined &&
      prevPitch !== undefined &&
      prevAbs !== undefined
    ) {
      const previous = prevGroupSpelled;
      if (tryEval(() => isForbiddenMelodicLeap(previous, spelled)) === true) {
        findings.forbiddenLeap = true;
      }
      // Alone among the three this one is a claim about the key rather than
      // about the voices, so it is only made where a key was actually set: with
      // none, the analysis falls back to C major and would announce a
      // resolution in a key nobody chose.
      if (keySet && tryEval(() => isLeadingToneResolution(previous, spelled, key)) === true) {
        findings.leadingToneResolution = true;
      }
      if (battutaWithOthers(spelled, previous, note.pitch, prevPitch, absBeat, prevAbs)) {
        findings.battuta = true;
      }
    }
    if (Object.keys(findings).length > 0) analysis.counterpoint = findings;
    byNoteId.set(note.id, analysis);
    lastPitch = note.pitch;
    lastSpelled = spelled;
  }

  // Melodic labels: one analyzeVoice pass over the clip's notes as a single
  // voice. Ids are carried directly on VoiceNote (rather than reducing to the
  // top voice, which would drop them); analyzeVoice treats shared onsets as
  // cluster members and skips melodic labels for them, so passing all notes
  // is safe. Results map back to notes through AnalyzedNote.noteId.
  const voice: VoiceNote[] = sorted.map((note) => ({
    id: note.id,
    pitch: note.pitch,
    startBeat: input.clipStartPpq + note.startPpq,
    durationBeat: note.durationPpq,
    velocity: note.velocity,
  }));
  const analyzedNotes =
    tryEval(() =>
      analyzeVoice(
        voice,
        (beat) => timeline.at(beat),
        key,
        (beat) => othersAt(beat),
      ),
    ) ?? [];
  for (const analyzed of analyzedNotes) {
    const entry = byNoteId.get(analyzed.noteId);
    if (entry !== undefined) entry.analyzed = analyzed;
  }

  return { segments, byNoteId, keySet, chordPresent };
}
