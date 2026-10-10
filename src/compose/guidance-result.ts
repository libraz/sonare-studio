import type { AnalyzedNote, NoteSafety, SafetyResult, VoicedRole } from '@libraz/libcantus';
import type { SpelledPitch } from '@/notation/pitch-spelling';
import type { NoteCadence } from './note-cadences';

/**
 * The step a suspension or stepped non-chord tone owes (placement rules r4,
 * r5, r8), judged against the pitch of the next onset nearest the note.
 */
export interface PendingResolution {
  kind: 'suspension' | 'nonChordTone';
  /** Pitches that resolve the note. */
  expected: number[];
  /** The continuation; absent while no onset follows. */
  next?: number;
  /** Whether `next` is expected; absent while no onset follows. */
  resolved?: boolean;
}

/**
 * A chord boundary reached while this note is still sounding. The boundary is
 * kept with the verdict so a card can explain where a sustained clash starts.
 */
export interface SustainedSafety {
  safety: NoteSafety.Warning | NoteSafety.Dissonant;
  chordStartPpq: number;
  /** One-based musical location used by the note theory card. */
  bar: number;
  beat: number;
}

/** Harmonic severity retained when one source note occurs in several loops. */
export type HarmonicSafety = NoteSafety.Warning | NoteSafety.Dissonant;

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
  /** Worst non-safe verdict at a later chord boundary inside this note. */
  sustainedSafety?: SustainedSafety;
  /** Worst harmonic severity across all audible loop occurrences of this note. */
  worstSafety?: HarmonicSafety;
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
  /** Resolution the note owes, when its placement reading is r4, r5 or r8. */
  pendingResolution?: PendingResolution;
  /** Accompaniment notes a following part parked so this note fits (rule r1). */
  thinnedAccompaniment?: Array<{ trackId: number; pitch: number }>;
  /**
   * The other tracks behind the pairwise reasons kept in {@link safety}, one
   * entry per track; their `reasons` together are exactly those flags.
   */
  partners?: Array<{ trackId: number; reasons: number }>;
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
