/**
 * Piano-roll composition guidance: per-chord-segment pitch-class safety tints
 * and per-note theory analysis for the active clip.
 *
 * Combines the compose adapters (key, chord timeline, meter, track hygiene)
 * with libcantus's safety/role/voice analysis into one deterministic pass.
 * Percussion never reaches the analysis — the voice lines arrive without it
 * (see `buildVoiceLines`) and the active clip's channel-10 notes are dropped
 * here — so drum hits never register as false dissonance against the melody.
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
  type KeyScale,
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
import type {
  EditorNote,
  EditorTrack,
  ScaleHighlightConfig,
  TimeSignatureSegment,
} from '@/project/types';
import { buildChordTimeline } from './chord-at-tick';
import {
  DEFAULT_GUIDANCE_PROFILE,
  type GuidanceProfile,
  toSafetyProfile,
} from './guidance-profile';
import { DEFAULT_KEY_SCALE } from './key';
import { buildKeyMap, type KeyMap } from './key-map';
import { strongBeatAt } from './meter';
import { cadenceArrivals, cadencesByNote, type NoteCadence } from './note-cadences';
import { editorNotesToNoteEvents } from './notes-io';
import { harmonicNotes } from './tracks';
import {
  buildVoiceContext,
  keySpeller,
  motionFindings,
  type OuterVoice,
  type VoiceLine,
} from './voice-context';

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
  /** Key timeline with `Key:` markers applied; defaults to {@link key} alone. */
  keyMap?: KeyMap;
  /** Project meter map. */
  timeSignatures: ReadonlyArray<TimeSignatureSegment>;
  /** Part-writing strictness (default {@link DEFAULT_GUIDANCE_PROFILE}). */
  profile?: GuidanceProfile;
  /**
   * Track of the active clip. Its channel-10 notes are dropped unless it is
   * explicitly marked non-percussion; when absent they are always dropped.
   */
  track?: EditorTrack;
  /** Other tracks as voice lines on the absolute timeline (see `buildVoiceLines`). */
  lines?: ReadonlyArray<VoiceLine>;
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
  /** Whether a key is set anywhere in the clip window. */
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
  key: KeyScale,
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

/** Stands in for an active clip whose track is not given: no percussion override. */
const UNFLAGGED_TRACK = {} as EditorTrack;

/**
 * Builds the full guidance for one active clip: background tint segments per
 * sounding chord, key region and meter pulse, plus a per-note theory analysis map.
 */
export function buildGuidance(input: GuidanceInput): GuidanceResult {
  const profile: SafetyProfile = toSafetyProfile(input.profile ?? DEFAULT_GUIDANCE_PROFILE);
  const keyMap = input.keyMap ?? buildKeyMap(input.key, []);
  const keyAt = (absBeat: number): KeyScale => keyMap.at(absBeat) ?? DEFAULT_KEY_SCALE;
  const timeline = buildChordTimeline(input.chordSymbols);
  const notes = harmonicNotes(input.track ?? UNFLAGGED_TRACK, input.notes);

  // Tint the explicit clip window, not merely the span occupied by notes.
  // This keeps long empty tails and entirely empty clips analyzable.
  const windowStart = input.clipStartPpq;
  const windowEnd = windowStart + Math.max(0, input.clipLengthPpq);
  const keySet =
    keyMap.keySetAt(windowStart) ||
    keyMap.regions.some(
      (region) => region.key !== null && region.endPpq > windowStart && region.startPpq < windowEnd,
    );

  // Voice context: one line per non-percussion other track, kept separate (not
  // pooled) so each voice's motion can be followed across time. Vertical
  // readings hear every pitch a line sounds; motion readings follow each line's
  // top voice. The note onsets are the only instants the context is queried
  // at, and they also carry the history a parallel is read against (see
  // {@link DOUBLING_RUN_SLOTS}), so the indexes are built once for the pass.
  const sorted = [...notes].sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch);
  const voiceQueryBeats = [
    ...new Set(sorted.map((note) => input.clipStartPpq + note.startPpq)),
  ].sort((a, b) => a - b);
  const lines = input.lines ?? [];
  const voices = buildVoiceContext(lines, voiceQueryBeats, input.timeSignatures);
  const activeLine: EditorNote[] = sorted.map((note) => ({
    ...note,
    startPpq: input.clipStartPpq + note.startPpq,
  }));

  /**
   * Each other line's top voice at `absBeat`, carrying its top at `prevBeat`
   * when given. The pitch there is not bar-bounded: evaluateSafety measures the
   * step unbounded, and the bar bound belongs to the dismissals below.
   */
  const topVoicesAt = (absBeat: number, prevBeat?: number): OuterVoice[] => {
    const tops = voices.outerVoicesAt(absBeat, undefined).filter((v) => v.edge === 'top');
    if (prevBeat === undefined) return tops;
    const prevTops = new Map(
      voices
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
   * The other lines at `absBeat` as libcantus voices: each top voice carrying
   * its pitch at `prevBeat` for the motion readings, then every other pitch
   * sounding with it, without a previous pitch, for the vertical ones.
   */
  const othersAt = (absBeat: number, prevBeat?: number): VoiceSnapshot[] => {
    const out: VoiceSnapshot[] = [];
    const seen = new Set<string>();
    for (const top of topVoicesAt(absBeat, prevBeat)) {
      seen.add(`${top.trackId}:${top.pitch}`);
      out.push(
        top.prevPitch !== undefined
          ? { pitch: top.pitch, prevPitch: top.prevPitch }
          : { pitch: top.pitch },
      );
    }
    for (const sounding of voices.soundingAt(absBeat)) {
      const id = `${sounding.trackId}:${sounding.pitch}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ pitch: sounding.pitch });
    }
    return out;
  };
  /** Interval to the bass (lowest pitch any other line sounds) for the card, if audible. */
  const verticalAt = (pitch: number, absBeat: number): VerticalInfo | undefined => {
    let bass: number | undefined;
    for (const sounding of voices.soundingAt(absBeat)) {
      bass = bass === undefined ? sounding.pitch : Math.min(bass, sounding.pitch);
    }
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
   * Whether more than an octave separates the candidate from the voice next to
   * it among the top voices sounding with it.
   *
   * Only adjacent pairs are asked, and never the bottom one: bass-to-tenor
   * spacing is conventionally exempt, and a melody carried an eleventh above a
   * bass line — which is most homophony — otherwise reports a fault on every
   * note it has. With two voices sounding, the only pair is that exempt one.
   */
  const wideSpacingAt = (pitch: number, absBeat: number): boolean => {
    const sounding = [pitch, ...topVoicesAt(absBeat).map((voice) => voice.pitch)].sort(
      (a, b) => a - b,
    );
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
    [{ trackId: 0, role: 'melodic', notes: activeLine }],
    voiceQueryBeats,
    input.timeSignatures,
  );
  const activeTopAt = (beat: number): number | undefined =>
    activeVoice.outerVoicesAt(beat, undefined)[0]?.pitch;
  const slotOfBeat = new Map(voiceQueryBeats.map((beat, slot) => [beat, slot]));
  /**
   * Per other line, the length of the unbroken run of slots holding one
   * constant separation from the active voice that each slot belongs to. A
   * separation neither voice defines (one of them silent) breaks the run, which
   * is what the NaN comparison below does.
   */
  const otherTopsBySlot = voiceQueryBeats.map(
    (beat) => new Map(topVoicesAt(beat).map((voice) => [voice.trackId, voice.pitch])),
  );
  const doublingRuns = new Map<number, Int32Array>();
  for (const line of lines) {
    const runs = new Int32Array(voiceQueryBeats.length);
    let runStart = 0;
    let held = Number.NaN;
    for (let slot = 0; slot <= voiceQueryBeats.length; slot++) {
      const beat = voiceQueryBeats[slot];
      const top = beat !== undefined ? activeTopAt(beat) : undefined;
      const other = beat !== undefined ? otherTopsBySlot[slot].get(line.trackId) : undefined;
      const separation = top !== undefined && other !== undefined ? top - other : Number.NaN;
      if (separation === held) continue;
      for (let filled = runStart; filled < slot; filled++) runs[filled] = slot - runStart;
      runStart = slot;
      held = separation;
    }
    doublingRuns.set(line.trackId, runs);
  }
  /**
   * Whether the library's parallel-perfect verdict on a candidate describes a
   * voice-leading event the composer can act on. The pairs that earned the bit
   * are rebuilt with the library's own predicate; the verdict stands unless
   * every one of them is dismissed, and a pair the rebuild cannot account for
   * keeps it.
   */
  const parallelPerfectIsReal = (
    pitch: number,
    prevPitch: number | undefined,
    absBeat: number,
    prevAbs: number | undefined,
  ): boolean => {
    if (prevPitch === undefined || prevAbs === undefined) return true;
    // Past the bar in force the two events are no longer heard as consecutive.
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
    // The runs span the whole slot run, so the earlier slots are the run minus
    // the candidate's own.
    const { parallelPerfect } = motionFindings(pitch, prevPitch, others, (other) => {
      const runs = doublingRuns.get(other.trackId);
      return isActiveVoice && slot !== undefined && runs !== undefined ? runs[slot] - 1 : 0;
    });
    return parallelPerfect.length > 0;
  };
  /**
   * Whether the library's hidden-parallel verdict describes a voice-leading
   * event the composer can act on: a direct fifth or octave is a fault between
   * the outer voices of the texture and accepted between inner parts. Rebuilt,
   * dismissed and bar-bounded the way the parallel reading above is.
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
   * The counterpoint predicates read spelled notes: an augmented second and a
   * minor third span the same three semitones, so a bare MIDI pair cannot state
   * the question they ask. The spelling counts intervals from the tonic of the
   * key in force at the note (see {@link keySpeller}); the engraving rule the
   * card's title uses would spell D minor's C# as Db and invent diminished
   * fourths nobody wrote.
   */
  const spellers = new Map<string, ReturnType<typeof keySpeller>>();
  const spellerFor = (key: KeyScale): ReturnType<typeof keySpeller> => {
    const id = `${key.rootPc}:${key.modeMask12}`;
    let speller = spellers.get(id);
    if (speller === undefined) {
      speller = keySpeller(key);
      spellers.set(id, speller);
    }
    return speller;
  };
  /**
   * Context-free spelling for the other voices, memoized per key and pitch.
   * They are only ever compared by perfect class — a comparison no spelling
   * changes — so they need a valid spelling rather than the best one.
   */
  const keySpellings = new Map<string, NoteData | undefined>();
  const spellFromKey = (pitch: number, key: KeyScale): NoteData | undefined => {
    const id = `${key.rootPc}:${key.modeMask12}:${pitch}`;
    if (keySpellings.has(id)) return keySpellings.get(id);
    const spelled = spellerFor(key)(pitch);
    keySpellings.set(id, spelled);
    return spelled;
  };
  /**
   * The staff reading of the clip's own notes: the spelling the score and the
   * MusicXML export engrave with, carried on the analysis so the hover card
   * names a note the way its notehead is written. A line can only be spelled
   * whole, so it is solved once per pass, one run per key region under that
   * region's signature. Notes where no key is set carry none.
   */
  const engravedByNoteId = new Map<number, SpelledPitch>();
  const runsByRegion = new Map<number, EditorNote[]>();
  for (const note of activeLine) {
    if (!keyMap.keySetAt(note.startPpq)) continue;
    const region = keyMap.regions.findIndex(
      (entry) => note.startPpq >= entry.startPpq && note.startPpq < entry.endPpq,
    );
    const run = runsByRegion.get(region);
    if (run === undefined) runsByRegion.set(region, [note]);
    else run.push(note);
  }
  for (const [region, run] of runsByRegion) {
    const engraved = spellLineInKeySignature(
      run.map((note) => ({
        midi: note.pitch,
        startBeat: note.startPpq,
        durationBeat: note.durationPpq,
      })),
      keyMap.keyFifthsAt(keyMap.regions[region].startPpq),
    );
    run.forEach((note, index) => {
      engravedByNoteId.set(note.id, engraved[index]);
    });
  }
  /**
   * Whether the candidate completes an *ottava battuta* against any other
   * voice: a perfect octave or unison reached by contrary motion with the upper
   * of the two voices leaping down onto it. It reuses the pair machinery above
   * but none of the parallel suppression, which dismisses contrary motion — the
   * very motion this rule is about.
   */
  const battutaWithOthers = (
    spelled: NoteData,
    prevSpelled: NoteData,
    pitch: number,
    prevPitch: number,
    absBeat: number,
    prevAbs: number,
    key: KeyScale,
  ): boolean => {
    for (const { pitch: other, prevPitch: otherPrev } of topVoicesAt(absBeat, prevAbs)) {
      if (otherPrev === undefined) continue;
      const otherSpelled = spellFromKey(other, key);
      const otherPrevSpelled = spellFromKey(otherPrev, key);
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
      // A chord can span several metric positions and key regions. Split it at
      // the active meter's beat unit and at each key change so the tint uses
      // the same context as the per-note analysis.
      for (let cursor = absStart; cursor < absEnd - 1e-6; ) {
        const meter = timeSignatureAt(input.timeSignatures, cursor);
        const meterUnitPpq = 4 / meter.denominator;
        const keyRegionEnd =
          keyMap.regions.find((region) => cursor >= region.startPpq && cursor < region.endPpq)
            ?.endPpq ?? Number.POSITIVE_INFINITY;
        const end = Math.min(absEnd, cursor + meterUnitPpq, keyRegionEnd);
        segments.push({
          startBeat: cursor - input.clipStartPpq + sourceOffset,
          endBeat: end - input.clipStartPpq + sourceOffset,
          safetyByPc: safetyRow(
            segment.chord,
            keyAt(cursor),
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
  // the shared timeline plus the other lines gathered for the voice context.
  // Reading them costs nothing when a chord track states the progression, so
  // the notes are only pooled when there is none to state it. Cadences and the
  // melodic labels below read the key in force at the clip's start.
  const windowKey = keyAt(windowStart);
  const cadenceNotes =
    input.chordSymbols.length > 0
      ? []
      : [
          ...editorNotesToNoteEvents(notes, input.clipStartPpq),
          ...lines.flatMap((line) => editorNotesToNoteEvents(line.notes)),
        ].sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);
  const cadences = cadenceArrivals(
    input.chordSymbols,
    cadenceNotes,
    windowKey,
    input.timeSignatures,
  );
  const cadenceByNoteId = cadencesByNote(
    notes,
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
   * came from, so the melodic reading needs one note of lookahead.
   */
  const groupPitchByOnset = new Map<number, number>();
  for (const note of activeLine) groupPitchByOnset.set(note.startPpq, note.pitch);
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
  for (const note of activeLine) {
    const absBeat = note.startPpq;
    if (absBeat !== groupOnset) {
      if (!Number.isNaN(groupOnset)) prevGroupOnset = groupOnset;
      if (lastPitch !== undefined) {
        prevGroupPitch = lastPitch;
        prevGroupSpelled = lastSpelled;
      }
      groupOnset = absBeat;
    }
    // This voice's previous onset group, so other voices are sampled at the
    // same two instants the candidate moves between.
    const prevAbs = prevGroupOnset;
    const key = keyAt(absBeat);
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
    const vertical = verticalAt(note.pitch, absBeat);
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
        otherVoices: othersAt(absBeat, prevAbs),
        strongBeat: strongBeatAt(input.timeSignatures, absBeat),
      }),
    );
    // The two motion-into-a-perfect-interval reasons are dismissed here rather
    // than where the card is written: the verdict is the analysis every surface
    // reads. Only those bits are cleared; the other reasons, the severity and
    // the `resolveTo` target are the library's answers untouched.
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
    // The readings the verdict's reason bits do not carry, measured across the
    // same step of the voice the verdict is measured across.
    const nextPitch = nextGroupPitchByOnset.get(absBeat);
    const spelled = spellerFor(key)(note.pitch, {
      ...(prevPitch !== undefined ? { previous: prevPitch } : {}),
      ...(nextPitch !== undefined ? { next: nextPitch } : {}),
    });
    const findings: CounterpointFindings = {};
    // Spacing reads one instant rather than a step, so it needs no previous note.
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
      // about the voices, so it is only made where a key was actually set.
      if (
        keyMap.keySetAt(absBeat) &&
        tryEval(() => isLeadingToneResolution(previous, spelled, key)) === true
      ) {
        findings.leadingToneResolution = true;
      }
      if (battutaWithOthers(spelled, previous, note.pitch, prevPitch, absBeat, prevAbs, key)) {
        findings.battuta = true;
      }
    }
    if (Object.keys(findings).length > 0) analysis.counterpoint = findings;
    byNoteId.set(note.id, analysis);
    lastPitch = note.pitch;
    lastSpelled = spelled;
  }

  // Melodic labels: one analyzeVoice pass over the clip's notes as a single
  // voice. Ids are carried directly on VoiceNote; analyzeVoice treats shared
  // onsets as cluster members and skips melodic labels for them, so passing all
  // notes is safe. Results map back to notes through AnalyzedNote.noteId.
  const voice: VoiceNote[] = activeLine.map((note) => ({
    id: note.id,
    pitch: note.pitch,
    startBeat: note.startPpq,
    durationBeat: note.durationPpq,
    velocity: note.velocity,
  }));
  const analyzedNotes =
    tryEval(() =>
      analyzeVoice(
        voice,
        (beat) => timeline.at(beat),
        windowKey,
        (beat) => othersAt(beat),
      ),
    ) ?? [];
  for (const analyzed of analyzedNotes) {
    const entry = byNoteId.get(analyzed.noteId);
    if (entry !== undefined) entry.analyzed = analyzed;
  }

  return { segments, byNoteId, keySet, chordPresent };
}
