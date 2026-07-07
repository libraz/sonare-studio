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
  chordScaleReport,
  evaluateSafety,
  isScaleTone,
  isStrongBeat,
  NoteSafety,
  pitchToScaleDegree,
  roleOf,
  type SafetyProfile,
  type SafetyResult,
  type VoicedRole,
  type VoiceNote,
  type VoiceSnapshot,
} from '@libraz/libcantus';
import type { EditorChordSymbol } from '@/project/chords';
import type { EditorNote, ScaleHighlightConfig, TimeSignatureSegment } from '@/project/types';
import { buildChordTimeline } from './chord-at-tick';
import { effectiveKeyScale } from './key';
import { segmentAtPpq, segmentToTimeSignature } from './meter';
import { harmonicTracksOnly, type TrackWithNotes } from './tracks';

/** Fallback clip window span in beats when the clip carries no notes yet. */
const DEFAULT_WINDOW_BEATS = 4;

/** Representative octave anchor: pitch class pc is evaluated as MIDI 60 + pc. */
const CENTER_C = 60;

export interface GuidanceInput {
  /** Active clip notes (clip-relative PPQ). */
  notes: ReadonlyArray<EditorNote>;
  /** Active clip timeline start in PPQ (to reach absolute beats). */
  clipStartPpq: number;
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
  /** Clip-relative beat span the segment covers (for drawing on the grid). */
  startBeat: number;
  endBeat: number;
  /** NoteSafety (0/1/2) per pitch class 0..11 for a placed note there. */
  safetyByPc: Uint8Array;
}

/** The best-fitting scale over the sounding chord, with its color/avoid tones. */
export interface ChordScaleInfo {
  /** Scale name (a key of libcantus NAMED_SCALES, e.g. 'ionian'). */
  scaleName: string;
  /** Available-tension pitch classes (usable color tones) over the chord. */
  tensions: number[];
  /** Avoid-note pitch classes over the chord. */
  avoid: number[];
}

/** Per-note theory analysis (keyed by EditorNote.id in the result map). */
export interface NoteAnalysis {
  safety?: SafetyResult;
  role?: VoicedRole;
  analyzed?: AnalyzedNote;
  /** 0-based scale degree of the note in the key (-1 for non-scale tones). */
  degree: number;
  isScaleTone: boolean;
  /** Best-fit scale and its color/avoid tones for the sounding chord, if any. */
  chordScale?: ChordScaleInfo;
}

export interface GuidanceResult {
  /** Background tint segments in clip-relative beats. */
  segments: GuidanceSegment[];
  /** Analysis per active-clip note id. */
  byNoteId: Map<number, NoteAnalysis>;
  /** Whether a key was set (highlight enabled). */
  keySet: boolean;
  /** Whether any chord covered the clip (progression present or inferable). */
  chordPresent: boolean;
}

/**
 * The pitch a note is expected to resolve to, from its analyzer labels
 * (suspension, needs-resolution, leading-tone all carry a `resolveTo` target),
 * or undefined when the note carries no resolution obligation.
 */
export function resolutionTargetOf(analysis: NoteAnalysis): number | undefined {
  for (const label of analysis.analyzed?.labels ?? []) {
    if ('resolveTo' in label && typeof label.resolveTo === 'number') return label.resolveTo;
  }
  return undefined;
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
 * Whether an absolute beat is metrically strong under the governing meter
 * segment. The beat is measured from the segment's own start so bar lines
 * follow meter changes rather than assuming bars anchored at beat 0.
 */
function strongBeatAt(segments: ReadonlyArray<TimeSignatureSegment>, absBeat: number): boolean {
  const segment = segmentAtPpq(segments, absBeat);
  const inSegmentBeat = Math.max(0, absBeat - segment.startPpq);
  return tryEval(() => isStrongBeat(inSegmentBeat, segmentToTimeSignature(segment))) ?? false;
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
 * sounding chord and a per-note theory analysis map.
 */
export function buildGuidance(input: GuidanceInput): GuidanceResult {
  const profile: SafetyProfile = input.profile ?? 'pop';
  const key = effectiveKeyScale(input.key);
  const keySet = input.key.enabled;
  const timeline = buildChordTimeline(input.chordSymbols);

  // Clip window in absolute beats; an empty clip keeps a minimal span so the
  // background still tints.
  const clipSpan = input.notes.reduce(
    (max, note) => Math.max(max, note.startPpq + note.durationPpq),
    0,
  );
  const windowStart = input.clipStartPpq;
  const windowEnd = windowStart + (clipSpan > 0 ? clipSpan : DEFAULT_WINDOW_BEATS);

  // Voice context from other tracks: drop percussion entirely, then drop any
  // note that belongs to the active clip itself (matched by note id).
  const activeIds = new Set(input.notes.map((note) => note.id));
  const otherNotes: EditorNote[] = [];
  if (input.otherTracks !== undefined) {
    const { harmonic } = harmonicTracksOnly(input.otherTracks);
    for (const item of harmonic) {
      for (const note of item.notes) {
        if (!activeIds.has(note.id)) otherNotes.push(note);
      }
    }
  }
  const othersAt = (absBeat: number): VoiceSnapshot[] => {
    const out: VoiceSnapshot[] = [];
    for (const note of otherNotes) {
      if (absBeat >= note.startPpq && absBeat < note.startPpq + note.durationPpq) {
        out.push({ pitch: note.pitch });
      }
    }
    return out;
  };

  // Background tint segments: one per chord segment overlapping the clip
  // window, or a single null-chord segment so scale membership still tints.
  const overlapping = timeline.segments.filter(
    (segment) => segment.endBeat > windowStart && segment.startBeat < windowEnd,
  );
  const chordPresent = overlapping.length > 0;
  const segments: GuidanceSegment[] = [];
  if (chordPresent) {
    for (const segment of overlapping) {
      const absStart = Math.max(segment.startBeat, windowStart);
      segments.push({
        startBeat: absStart - input.clipStartPpq,
        endBeat: segment.endBeat - input.clipStartPpq,
        safetyByPc: safetyRow(
          segment.chord,
          key,
          profile,
          strongBeatAt(input.timeSignatures, absStart),
        ),
      });
    }
  } else {
    segments.push({
      startBeat: 0,
      endBeat: windowEnd - windowStart,
      safetyByPc: safetyRow(null, key, profile, strongBeatAt(input.timeSignatures, windowStart)),
    });
  }

  // Per-note analysis, in time order so prevPitch reflects the preceding
  // onset group (cluster members never count each other as "previous").
  const sorted = [...input.notes].sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch);
  const byNoteId = new Map<number, NoteAnalysis>();
  // Chord-scale reports are chord-only, so memoize by chord identity to avoid
  // recomputing the scale fit for every note under the same chord.
  const chordScaleCache = new Map<string, ChordScaleInfo | undefined>();
  const chordScaleFor = (chord: ChordData): ChordScaleInfo | undefined => {
    const identity = `${chord.rootPc}:${chord.quality}:${chord.bassPc ?? -1}`;
    const cached = chordScaleCache.get(identity);
    if (cached !== undefined || chordScaleCache.has(identity)) return cached;
    const report = tryEval(() => chordScaleReport(chord, 1));
    const best = report?.[0];
    const info: ChordScaleInfo | undefined =
      best !== undefined
        ? { scaleName: best.name, tensions: best.tensions, avoid: best.avoid }
        : undefined;
    chordScaleCache.set(identity, info);
    return info;
  };
  let prevGroupPitch: number | undefined;
  let lastPitch: number | undefined;
  let groupOnset = Number.NaN;
  for (const note of sorted) {
    if (note.startPpq !== groupOnset) {
      prevGroupPitch = lastPitch ?? prevGroupPitch;
      groupOnset = note.startPpq;
    }
    const absBeat = input.clipStartPpq + note.startPpq;
    const chord = timeline.at(absBeat);
    const analysis: NoteAnalysis = {
      degree: pitchToScaleDegree(note.pitch, key),
      isScaleTone: isScaleTone(note.pitch, key),
    };
    if (chord !== null) {
      const role = tryEval(() => roleOf(note.pitch, chord));
      if (role !== undefined) analysis.role = role;
      const chordScale = chordScaleFor(chord);
      if (chordScale !== undefined) analysis.chordScale = chordScale;
    }
    const prevPitch = prevGroupPitch;
    const safety = tryEval(() =>
      evaluateSafety({
        profile,
        candidatePitch: note.pitch,
        prevPitch,
        chord,
        key,
        otherVoices: othersAt(absBeat),
        strongBeat: strongBeatAt(input.timeSignatures, absBeat),
      }),
    );
    if (safety !== undefined) analysis.safety = safety;
    byNoteId.set(note.id, analysis);
    lastPitch = note.pitch;
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
