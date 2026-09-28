/**
 * Re-generates one aligned section of an existing drum clip.
 *
 * A drum section is edited in place so the track, clip placement, source
 * offset and all clip-scoped settings survive. The command deliberately
 * requires one non-looping MIDI clip to cover the complete section. A range
 * that would need flattening a loop or merging several clips is rejected with
 * a useful error instead of silently changing material outside the request.
 */

import { isDrumTrack } from '@/compose/tracks';
import type { RawNote } from '../midi-events';
import { getProject, notesToProjectEvents, useProjectStore } from '../store';
import { isFourFourBarRange, measureRangeAt } from '../time-signature';
import { clipKind, type EditorClip, type EditorNote } from '../types';
import { buildDrumsPlan, type GenerateDrumsParams } from './generate-drums';
import { type AtomicProjectEdit, executeAtomic } from './history';
import { requireEditableTrack } from './utils';

/** The small tolerance used when checking PPQ bar boundaries. */
const PPQ_EPSILON = 1e-7;

/** Input for {@link regenerateDrumsRangeCommand}. */
export interface RegenerateDrumsRangeParams extends GenerateDrumsParams {
  /** Existing MIDI drum track to edit. */
  trackId: number;
  /** Inclusive section start on the arrangement timeline. */
  startPpq: number;
  /** Exclusive section end on the arrangement timeline. */
  endPpq: number;
}

/** Prepared one-clip replacement, consumed by the atomic command boundary. */
export interface DrumsRangePlan {
  trackId: number;
  clipId: number;
  /** New source-relative notes for the existing clip. */
  notes: RawNote[];
  /** Existing notes retained outside the replacement range, with their ids. */
  idHints: EditorNote[];
  /** Number of newly generated drum hits. */
  generatedCount: number;
}

function rangeBars(startPpq: number, endPpq: number): number {
  const lengthPpq = endPpq - startPpq;
  const bars = lengthPpq / 4;
  if (!Number.isInteger(bars) || bars <= 0) {
    throw new RangeError(
      `Drum regeneration range must contain a positive whole number of 4/4 bars, got ${lengthPpq}`,
    );
  }
  return bars;
}

function atSamePpq(left: number, right: number): boolean {
  return Math.abs(left - right) <= PPQ_EPSILON;
}

/** Checks the range against the project's actual meter map and bar grid. */
function validateFourFourRange(
  store: ReturnType<typeof useProjectStore>,
  startPpq: number,
  endPpq: number,
): number {
  if (!Number.isFinite(startPpq) || startPpq < 0) {
    throw new RangeError(`Drum regeneration startPpq must be finite and >= 0, got ${startPpq}`);
  }
  if (!Number.isFinite(endPpq) || endPpq <= startPpq) {
    throw new RangeError(
      `Drum regeneration endPpq must be finite and greater than startPpq, got ${endPpq}`,
    );
  }
  const bars = rangeBars(startPpq, endPpq);
  const startMeasure = measureRangeAt(store.timeSignatures, startPpq);
  // The generator's output starts at the first beat of the requested section.
  // Rejecting an off-grid start avoids a hidden half-bar shift in its groove.
  if (!atSamePpq(startMeasure.startPpq, startPpq)) {
    throw new RangeError('Drum regeneration must start on a 4/4 bar boundary.');
  }
  const endMeasure = measureRangeAt(store.timeSignatures, endPpq - PPQ_EPSILON);
  const endOfMeasure = endMeasure.startPpq + endMeasure.lengthPpq;
  if (!atSamePpq(endOfMeasure, endPpq)) {
    throw new RangeError('Drum regeneration must end on a 4/4 bar boundary.');
  }
  if (!isFourFourBarRange(store.timeSignatures, startPpq, bars)) {
    throw new RangeError('Drum generation currently supports 4/4 bars only.');
  }
  return bars;
}

function rawNote(note: EditorNote): RawNote {
  return {
    pitch: note.pitch,
    velocity: note.velocity,
    startPpq: note.startPpq,
    durationPpq: note.durationPpq,
    channel: note.channel,
    ...(note.offVelocity !== undefined ? { offVelocity: note.offVelocity } : {}),
  };
}

function rawGeneratedNote(clip: EditorClip, sectionStartPpq: number, note: RawNote): RawNote {
  return {
    ...note,
    // Drum generator notes are section-relative. Project MIDI events are
    // source-relative, so include both the timeline section offset and the
    // clip's source window offset when merging them into the old clip.
    startPpq: clip.sourceOffsetPpq + sectionStartPpq + note.startPpq - clip.startPpq,
  };
}

function clipIntersectsRange(clip: EditorClip, startPpq: number, endPpq: number): boolean {
  const clipEndPpq = clip.startPpq + clip.lengthPpq;
  return clip.startPpq < endPpq && clipEndPpq > startPpq;
}

/**
 * Prepares an in-place drum section replacement without writing to the
 * Project. This is also used by the batch generator so all selected parts
 * share one {@link executeAtomic} undo entry.
 */
export function buildDrumsRangePlan(
  store: ReturnType<typeof useProjectStore>,
  params: RegenerateDrumsRangeParams,
): DrumsRangePlan | null {
  const bars = validateFourFourRange(store, params.startPpq, params.endPpq);
  const track = requireEditableTrack(store, params.trackId);
  if (track.kind !== 'midi') {
    throw new RangeError(`Drum regeneration requires a MIDI track: ${params.trackId}`);
  }

  const trackClips = store.clips.filter((clip) => clip.trackId === params.trackId);
  const midiClips = trackClips.filter((clip) => clipKind(clip) === 'midi');
  const trackNotes = midiClips.flatMap((clip) => clip.notes);
  if (!isDrumTrack(track, trackNotes)) {
    throw new RangeError(`Track ${params.trackId} is not classified as a drum track.`);
  }

  const intersecting = midiClips.filter((clip) =>
    clipIntersectsRange(clip, params.startPpq, params.endPpq),
  );
  const covering = intersecting.filter(
    (clip) =>
      clip.startPpq <= params.startPpq + PPQ_EPSILON &&
      clip.startPpq + clip.lengthPpq >= params.endPpq - PPQ_EPSILON,
  );
  if (intersecting.length !== 1 || covering.length !== 1) {
    throw new RangeError(
      'Drum regeneration requires one MIDI clip to cover the complete section; split or overlapping clips must be joined first.',
    );
  }
  const clip = covering[0];
  if (clip.loopEnabled) {
    throw new RangeError(
      'Drum regeneration cannot edit a looped clip safely; turn Loop off or consolidate the section first.',
    );
  }

  const generatedPlan = buildDrumsPlan(store, { ...params, bars }, params.startPpq);
  if (generatedPlan === null) return null;

  const retained = clip.notes.filter((note) => {
    const timelineStartPpq = clip.startPpq + note.startPpq - clip.sourceOffsetPpq;
    // Replace note onsets inside the requested range. Notes that start before
    // the range are intentionally retained so a sustain crossing the section
    // boundary remains exactly as the user authored it.
    return !(
      timelineStartPpq >= params.startPpq - PPQ_EPSILON &&
      timelineStartPpq < params.endPpq - PPQ_EPSILON
    );
  });
  const generated = generatedPlan.notes.map((note) =>
    rawGeneratedNote(clip, params.startPpq, note),
  );

  return {
    trackId: params.trackId,
    clipId: clip.id,
    notes: [...retained.map(rawNote), ...generated],
    idHints: retained.map((note) => ({ ...note })),
    generatedCount: generated.length,
  };
}

/** Applies a prepared range plan inside an enclosing atomic command. */
export function applyDrumsRangePlan(
  store: ReturnType<typeof useProjectStore>,
  plan: DrumsRangePlan,
  edit: AtomicProjectEdit,
): number {
  edit(1, () => getProject().setMidiEvents(plan.clipId, notesToProjectEvents(plan.notes)));
  store.refresh(new Map([[plan.clipId, plan.idHints]]));
  return plan.generatedCount;
}

/**
 * Generates a new drum variation into one existing section.
 *
 * @returns Number of generated hits written, or zero when libcantus emitted no
 * hits for the requested density/difficulty.
 */
export function regenerateDrumsRangeCommand(params: RegenerateDrumsRangeParams): number {
  const store = useProjectStore();
  const plan = buildDrumsRangePlan(store, params);
  if (plan === null) return 0;
  executeAtomic((edit) => {
    applyDrumsRangePlan(store, plan, edit);
  });
  return plan.generatedCount;
}
