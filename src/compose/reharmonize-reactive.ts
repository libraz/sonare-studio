/**
 * Reactive (melody-first) reharmonization: given the current chord track and a
 * melody the composer just edited, propose an updated progression that follows
 * the melody — without the progression "jumping around" on every keystroke.
 *
 * `harmonizeMelody` (libcantus) harmonizes a whole melody globally; it has no
 * notion of a current progression, locked regions, or a local edit. This module
 * layers the stabilization the plan calls for on top of it:
 *
 *  - **Locked regions are inviolable** — a chord overlapping a locked span is
 *    kept verbatim, never replaced.
 *  - **Local scope** — only the edited span and its immediate neighbours are
 *    eligible to change; the rest of the progression is preserved.
 *  - **Hysteresis** — an eligible chord is kept when it still fits its melody
 *    (no melody note clashes with it), so a small edit that leaves the harmony
 *    working does not flip the chord. A chord is replaced only when the melody
 *    no longer fits it.
 *
 * The result is a *proposal*: the caller shows it for approval and commits it as
 * a single undoable edit. Pure module (no Vue/Pinia); libcantus calls are
 * guarded so unexpected input degrades to "no change" rather than throwing.
 */

import {
  type ChordSpan,
  evaluateSafety,
  harmonizeMelody,
  isStrongBeat,
  type MelodyNote,
  NoteSafety,
  type SafetyProfile,
} from '@libraz/libcantus';
import type { EditorChordSymbol } from '@/project/chords';
import type { ReharmonizeStrength } from '@/project/command/generate-harmonize';
import type { ScaleHighlightConfig, TimeSignatureSegment } from '@/project/types';
import { chordSpanToEditorChord, editorChordToChord } from './chord-io';
import { effectiveKeyScale, scaleHighlightToKeyScale } from './key';
import { segmentAtPpq, segmentToTimeSignature } from './meter';

/** A single melody note on the absolute timeline (PPQ == quarter-note beats). */
export interface ReactiveMelodyNote {
  pitch: number;
  startPpq: number;
  durationPpq: number;
}

/** An inviolable progression span the composer has pinned. */
export interface LockedRegion {
  startPpq: number;
  endPpq: number;
}

/** Input to {@link proposeReactiveReharmonization}. */
export interface ReactiveReharmonizeInput {
  /** The current chord track (any order; sorted internally). */
  current: ReadonlyArray<EditorChordSymbol>;
  /** The melody driving the harmony, on the absolute timeline. */
  melody: ReadonlyArray<ReactiveMelodyNote>;
  /** The region touched by the edit that triggered this pass, in absolute PPQ. */
  editedSpan: { startPpq: number; endPpq: number };
  /** Spans the composer has locked; chords overlapping these are never changed. */
  locked?: ReadonlyArray<LockedRegion>;
  /** Project key context; drives both the fresh harmonization and the fit test. */
  key: ScaleHighlightConfig;
  /** Meter, for strong-beat weighting of the fit test. */
  timeSignatures: ReadonlyArray<TimeSignatureSegment>;
  /** Beats per segment for the fresh harmonization pass (default 4). */
  harmonicRhythm?: number;
  /** Candidate-pool strength for the fresh harmonization (default 'diatonic'). */
  reharmonize?: ReharmonizeStrength;
  /** Deterministic tie-break seed (default 0). */
  seed?: number;
}

/** A proposed reharmonization, ready to show for approval. */
export interface ReharmonizationProposal {
  /** The full proposed chord track (same regions as `current`, sorted by start). */
  proposal: EditorChordSymbol[];
  /** Whether the proposal differs from the current progression. */
  changed: boolean;
  /** Indices (into the sorted current track) whose chord the proposal changes. */
  changedIndices: number[];
}

/** Safety profile used for the melody-fit test (matches the guidance default). */
const FIT_PROFILE: SafetyProfile = 'pop';

/** Whether two chord symbols denote the same chord (region ignored). */
function sameChord(a: EditorChordSymbol, b: EditorChordSymbol): boolean {
  return a.rootPc === b.rootPc && a.quality === b.quality && (a.bassPc ?? -1) === (b.bassPc ?? -1);
}

/** Whether a chord region overlaps any locked span. */
function isLocked(chord: EditorChordSymbol, locked: ReadonlyArray<LockedRegion>): boolean {
  return locked.some((region) => chord.endPpq > region.startPpq && chord.startPpq < region.endPpq);
}

/** Whether an absolute beat is metrically strong under the governing meter. */
function strongBeatAt(segments: ReadonlyArray<TimeSignatureSegment>, absBeat: number): boolean {
  const segment = segmentAtPpq(segments, absBeat);
  const inSegmentBeat = Math.max(0, absBeat - segment.startPpq);
  try {
    return isStrongBeat(inSegmentBeat, segmentToTimeSignature(segment));
  } catch {
    return false;
  }
}

/**
 * The set of current-track indices eligible to change: every segment the edited
 * span touches, extended by one neighbour on each side. Neighbours are included
 * so a chord flanking the edit can adjust to a new harmonic context, which is
 * where reharmonization most often needs to reach.
 */
function eligibleIndices(
  current: ReadonlyArray<EditorChordSymbol>,
  editedSpan: { startPpq: number; endPpq: number },
): Set<number> {
  const touched: number[] = [];
  for (let i = 0; i < current.length; i++) {
    const chord = current[i];
    if (chord.endPpq > editedSpan.startPpq && chord.startPpq < editedSpan.endPpq) touched.push(i);
  }
  const eligible = new Set<number>();
  if (touched.length === 0) return eligible;
  const first = touched[0];
  const last = touched[touched.length - 1];
  for (let i = Math.max(0, first - 1); i <= Math.min(current.length - 1, last + 1); i++) {
    eligible.add(i);
  }
  return eligible;
}

/**
 * Whether the chord still fits the melody in its region. A chord fits when it
 * actually supports the segment's melody: at least one overlapping melody note
 * is a chord tone and none clashes (is dissonant). A chord that shares no tone
 * with the melody — even if nothing outright clashes — is a poor harmonization
 * and is open to replacement; one that still supports the melody is kept
 * (hysteresis), so a small edit that leaves the harmony working does not flip
 * the chord. A segment with no melody note is treated as fitting (nothing to
 * reharmonize), and an evaluation failure never condemns the chord.
 */
function chordFitsMelody(
  chord: EditorChordSymbol,
  melody: ReadonlyArray<ReactiveMelodyNote>,
  key: ReturnType<typeof effectiveKeyScale>,
  timeSignatures: ReadonlyArray<TimeSignatureSegment>,
): boolean {
  const chordData = editorChordToChord(chord);
  let hasNote = false;
  let hasChordTone = false;
  for (const note of melody) {
    if (note.startPpq + note.durationPpq <= chord.startPpq || note.startPpq >= chord.endPpq) {
      continue;
    }
    hasNote = true;
    try {
      const result = evaluateSafety({
        profile: FIT_PROFILE,
        candidatePitch: note.pitch,
        chord: chordData,
        key,
        otherVoices: [],
        strongBeat: strongBeatAt(timeSignatures, note.startPpq),
      });
      if (result.safety === NoteSafety.Dissonant) return false;
      if (result.safety === NoteSafety.Safe) hasChordTone = true;
    } catch {
      // An unevaluable note neither supports nor condemns the chord.
    }
  }
  return !hasNote || hasChordTone;
}

/**
 * Builds a sampler over the fresh harmonization: the chord span covering a beat
 * is the last span that starts at or before it. Returns null when no span
 * covers the beat (e.g. before the first span).
 */
function freshChordSampler(spans: ReadonlyArray<ChordSpan>): (beat: number) => ChordSpan | null {
  const sorted = [...spans].sort((a, b) => a.startBeat - b.startBeat);
  return (beat: number) => {
    let found: ChordSpan | null = null;
    for (const span of sorted) {
      if (span.startBeat <= beat) found = span;
      else break;
    }
    return found;
  };
}

/**
 * Proposes a reactive reharmonization of the current chord track for the given
 * melody and edit, respecting locked regions, local scope and hysteresis.
 *
 * @param input Current chords, melody, edited span, locks, key and meter.
 * @returns The proposed chord track plus which chords it changes. When nothing
 *   should change (empty inputs, a locked/settled edit, or a library failure)
 *   the proposal equals the current track and `changed` is false.
 */
export function proposeReactiveReharmonization(
  input: ReactiveReharmonizeInput,
): ReharmonizationProposal {
  const current = [...input.current].sort((a, b) => a.startPpq - b.startPpq);
  const unchanged: ReharmonizationProposal = {
    proposal: current.map((chord) => ({ ...chord })),
    changed: false,
    changedIndices: [],
  };
  if (current.length === 0 || input.melody.length === 0) return unchanged;

  const eligible = eligibleIndices(current, input.editedSpan);
  if (eligible.size === 0) return unchanged;

  const melodyNotes: MelodyNote[] = input.melody.map((note) => ({
    pitch: note.pitch,
    startBeat: note.startPpq,
    durationBeat: note.durationPpq,
  }));
  let spans: ChordSpan[];
  try {
    const result = harmonizeMelody({
      melody: melodyNotes,
      key: input.key.enabled ? scaleHighlightToKeyScale(input.key) : 'infer',
      harmonicRhythm: input.harmonicRhythm ?? 4,
      reharmonize: input.reharmonize ?? 'diatonic',
      placement: { transposeSearch: false, octaveSearch: false },
      seed: input.seed ?? 0,
    });
    spans = result.chords;
  } catch {
    return unchanged;
  }
  const freshAt = freshChordSampler(spans);
  const key = effectiveKeyScale(input.key);
  const locked = input.locked ?? [];

  const proposal: EditorChordSymbol[] = [];
  const changedIndices: number[] = [];
  for (let i = 0; i < current.length; i++) {
    const chord = current[i];
    // Locked or out-of-scope chords are preserved verbatim.
    if (!eligible.has(i) || isLocked(chord, locked)) {
      proposal.push({ ...chord });
      continue;
    }
    // Hysteresis: a chord that still fits its melody is not disturbed.
    if (chordFitsMelody(chord, input.melody, key, input.timeSignatures)) {
      proposal.push({ ...chord });
      continue;
    }
    const mid = (chord.startPpq + chord.endPpq) / 2;
    const freshSpan = freshAt(mid);
    if (freshSpan === null) {
      proposal.push({ ...chord });
      continue;
    }
    const replacement = chordSpanToEditorChord(freshSpan, chord.startPpq, chord.endPpq);
    if (sameChord(replacement, chord)) {
      proposal.push({ ...chord });
      continue;
    }
    proposal.push(replacement);
    changedIndices.push(i);
  }
  return { proposal, changed: changedIndices.length > 0, changedIndices };
}
