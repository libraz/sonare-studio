/**
 * Batch track-generation command.
 *
 * Writes any combination of the five instrumental parts (motif, drums, bass,
 * counter melody, backing) in one undoable transaction, so a multi-select run
 * lands as a single history entry and one undo removes all of it. Each part is
 * routed to its own target: a fresh track, a replacement of an existing
 * generated track (E2 — new track composed with the old one's removal in the
 * same transaction, inheriting position/name/mixer where feasible), or — motif
 * only — the active clip (append or replace).
 *
 * The generators build their notes through the shared plan builders, which do
 * not touch the Project, so this command is the sole `execute` boundary for the
 * whole batch (never nesting the single-shot commands' own boundaries).
 *
 * A batch that writes both a motif and a backing makes the backing follow the
 * motif's track; the lead-follow reconciler thins it in the same entry.
 */

import type { EditorChordSymbol } from '../chords';
import type { TrackPart } from '../generation';
import { getProject, notesToProjectEvents, useProjectStore } from '../store';
import { isFourFourBarRange } from '../time-signature';
import { applyProjectChords, sameChordStream, tileChordSymbols } from './chords';
import { buildBackingPlan, type GenerateBackingParams } from './generate-backing';
import { buildBassPlan, type GenerateBassParams } from './generate-bass';
import { buildCounterPlan, type GenerateCounterMelodyParams } from './generate-counter-melody';
import { buildDrumsPlan, type GenerateDrumsParams } from './generate-drums';
import {
  applyDrumsRangePlan,
  buildDrumsRangePlan,
  type RegenerateDrumsRangeParams,
} from './generate-drums-range';
import { buildMotifClipMerge, buildMotifPlan, type GenerateMotifParams } from './generate-motif';
import { addGeneratedTrack, EDITS_PER_TRACK, type TrackPlan } from './generate-track';
import { type AtomicProjectEdit, executeAtomic } from './history';
import { leadFollowRejection } from './lead-follow';
import { pruneClipScoreAnnotations } from './tracks';
import { requireEditableClip, requireEditableTrack } from './utils';

export type { TrackPart };

/** Where a generated part is written. */
export type BatchTarget =
  /** A fresh track (the default). */
  | { kind: 'new' }
  /** Replace an existing track, inheriting its slot/name/mixer where feasible. */
  | { kind: 'replaceTrack'; trackId: number }
  /** Drums only: replace a four-four section inside one existing drum clip. */
  | { kind: 'replaceRange'; trackId: number; startPpq: number; endPpq: number }
  /** Motif only: write into the active MIDI clip. */
  | { kind: 'clip'; mode: 'append' | 'replace' };

/** One selected part with its parameters and write target. */
export type BatchPartSpec =
  | { part: 'motif'; params: GenerateMotifParams; target: BatchTarget }
  | { part: 'drums'; params: GenerateDrumsParams; target: BatchTarget }
  | { part: 'bass'; params: GenerateBassParams; target: BatchTarget }
  | { part: 'counter'; params: GenerateCounterMelodyParams; target: BatchTarget }
  | { part: 'backing'; params: GenerateBackingParams; target: BatchTarget };

/** Optional arrangement-wide length for a whole generation run. */
export interface GenerateTracksBatchOptions {
  /** Number of four-four bars in the generated chord-dependent arrangement. */
  targetBars?: number;
}

/** One deferred write plus the number of wasm-Project edits it performs. */
interface BatchOp {
  part: TrackPart;
  edits: number;
  /** Performs the write and returns the id of the track it wrote. */
  apply: (edit: AtomicProjectEdit) => number;
}

/** Id of the track owning a clip the batch just created. */
function trackOfClip(store: ReturnType<typeof useProjectStore>, clipId: number): number {
  const clip = store.clips.find((entry) => entry.id === clipId);
  if (clip === undefined) throw new Error(`Generated clip ${clipId} is missing`);
  return clip.trackId;
}

/** Makes the generated backing follow the generated motif when the pair is allowed. */
function followMotif(
  store: ReturnType<typeof useProjectStore>,
  written: ReadonlyMap<TrackPart, number>,
): void {
  const motifTrackId = written.get('motif');
  const backingTrackId = written.get('backing');
  if (motifTrackId === undefined || backingTrackId === undefined) return;
  if (leadFollowRejection(store, backingTrackId, motifTrackId) !== null) return;
  store.tracks = store.tracks.map((track) =>
    track.id === backingTrackId
      ? { ...track, leadFollow: { leadTrackId: motifTrackId, stash: [] } }
      : track,
  );
}

/** Builds the new-track plan for a part spec (motif's clip target excluded). */
function planFor(
  store: ReturnType<typeof useProjectStore>,
  spec: BatchPartSpec,
  chords: ReadonlyArray<EditorChordSymbol>,
): TrackPlan | null {
  switch (spec.part) {
    case 'motif':
      return buildMotifPlan(store, spec.params, chords);
    case 'drums':
      return buildDrumsPlan(store, spec.params);
    case 'bass':
      return buildBassPlan(store, spec.params, chords);
    case 'counter':
      return buildCounterPlan(store, spec.params, chords);
    case 'backing':
      return buildBackingPlan(store, spec.params, chords);
  }
}

/**
 * Replaces generated content in place on an existing MIDI track. The track id
 * and every track-scoped property/reference therefore survive: automation,
 * group/VCA membership, solo-safe/freeze/record routing, instruments, MIDI
 * learn and sidechain references. Performs one remove per old clip followed
 * by addClip (source registration + clip insertion) + setMidiEvents.
 */
function replaceTrack(
  store: ReturnType<typeof useProjectStore>,
  trackId: number,
  plan: TrackPlan,
  edit: AtomicProjectEdit,
): void {
  const track = requireEditableTrack(store, trackId);
  if (track.kind !== 'midi') {
    throw new RangeError(`Generated content can only replace an existing MIDI track: ${trackId}`);
  }
  const oldClips = store.clips.filter((clip) => clip.trackId === trackId);
  for (const clip of oldClips) edit(1, () => getProject().removeClip(clip.id));
  pruneClipScoreAnnotations(
    store,
    oldClips.map((clip) => clip.id),
  );
  const clipId = edit(2, () =>
    getProject().addClip({
      trackId,
      isMidi: true,
      startPpq: 0,
      lengthPpq: plan.lengthPpq,
    }),
  );
  edit(1, () => getProject().setMidiEvents(clipId, notesToProjectEvents(plan.notes)));
  store.refresh();
  store.clips = store.clips.map((clip) =>
    clip.id === clipId ? { ...clip, name: track.name } : clip,
  );
  // The track keeps its id and its name, so the record is the only thing that
  // says which part now sounds on it.
  if (plan.provenance !== undefined) {
    const provenance = plan.provenance;
    store.tracks = store.tracks.map((entry) =>
      entry.id === trackId ? { ...entry, generated: { ...provenance } } : entry,
    );
  }
}

/** Builds deferred writes from the store state visible at this point. */
function buildBatchOps(
  store: ReturnType<typeof useProjectStore>,
  specs: ReadonlyArray<BatchPartSpec>,
  chords: ReadonlyArray<EditorChordSymbol>,
): BatchOp[] {
  const project = getProject();
  const ops: BatchOp[] = [];

  for (const spec of specs) {
    if (spec.target.kind === 'clip') {
      if (spec.part !== 'motif') continue;
      const clip = store.activeClip;
      if (clip === null) continue;
      requireEditableClip(store, clip.id);
      const mode = spec.target.mode;
      const merged = buildMotifClipMerge(store, clip, spec.params, mode, chords);
      if (merged === null) continue;
      ops.push({
        part: spec.part,
        edits: 1,
        apply: (edit) => {
          edit(1, () => project.setMidiEvents(clip.id, notesToProjectEvents(merged)));
          return clip.trackId;
        },
      });
      continue;
    }

    if (spec.target.kind === 'replaceRange') {
      if (spec.part !== 'drums') {
        throw new RangeError('The replaceRange target is supported for drums only.');
      }
      const rangePlan = buildDrumsRangePlan(store, {
        ...spec.params,
        trackId: spec.target.trackId,
        startPpq: spec.target.startPpq,
        endPpq: spec.target.endPpq,
      } satisfies RegenerateDrumsRangeParams);
      if (rangePlan === null) continue;
      ops.push({
        part: spec.part,
        edits: 1,
        apply: (edit) => {
          applyDrumsRangePlan(store, rangePlan, edit);
          return rangePlan.trackId;
        },
      });
      continue;
    }

    const plan = planFor(store, spec, chords);
    if (plan === null) continue;

    if (spec.target.kind === 'replaceTrack') {
      const trackId = spec.target.trackId;
      const existing = store.tracks.find((track) => track.id === trackId);
      if (existing) requireEditableTrack(store, trackId);
      if (existing?.kind !== undefined && existing.kind !== 'midi') {
        throw new RangeError(
          `Generated content can only replace an existing MIDI track: ${trackId}`,
        );
      }
      const oldClipCount = store.clips.filter((clip) => clip.trackId === trackId).length;
      ops.push({
        part: spec.part,
        edits: existing ? oldClipCount + 3 : EDITS_PER_TRACK,
        apply: (edit) => {
          if (existing) {
            replaceTrack(store, trackId, plan, edit);
            return trackId;
          }
          const clipId = addGeneratedTrack(
            store,
            {
              name: plan.name,
              notes: plan.notes,
              startPpq: 0,
              lengthPpq: plan.lengthPpq,
              preset: plan.preset,
              provenance: plan.provenance,
            },
            edit,
          );
          return trackOfClip(store, clipId);
        },
      });
      continue;
    }

    ops.push({
      part: spec.part,
      edits: EDITS_PER_TRACK,
      apply: (edit) =>
        trackOfClip(
          store,
          addGeneratedTrack(
            store,
            {
              name: plan.name,
              notes: plan.notes,
              startPpq: 0,
              lengthPpq: plan.lengthPpq,
              preset: plan.preset,
              provenance: plan.provenance,
            },
            edit,
          ),
        ),
    });
  }

  return ops;
}

/**
 * Generates the selected parts in one undoable transaction.
 *
 * @param specs The parts to generate, each with its parameters and target.
 * @returns The number of parts actually written (empty generations are
 *   skipped).
 */
export function generateTracksBatchCommand(
  specs: ReadonlyArray<BatchPartSpec>,
  options: GenerateTracksBatchOptions = {},
): number {
  const store = useProjectStore();
  const targetBars = options.targetBars;
  if (targetBars !== undefined) {
    if (!Number.isInteger(targetBars) || targetBars < 1 || targetBars > 256) {
      throw new RangeError(`Target bars must be an integer from 1 to 256, got ${targetBars}`);
    }
    if (!isFourFourBarRange(store.timeSignatures, 0, targetBars)) {
      throw new RangeError('Whole generation currently supports 4/4 bars only.');
    }
  }
  const targetChords =
    targetBars === undefined || store.chords.length === 0
      ? undefined
      : tileChordSymbols(store.chords, targetBars * 4);
  const effectiveChords: ReadonlyArray<EditorChordSymbol> = targetChords ?? store.chords;
  const preflightOps = buildBatchOps(store, specs, effectiveChords);

  const writesChords =
    targetChords !== undefined &&
    targetChords.length > 0 &&
    preflightOps.length > 0 &&
    !sameChordStream(store.chords, targetChords);
  const totalEdits = preflightOps.reduce((sum, op) => sum + op.edits, 0) + (writesChords ? 1 : 0);
  if (totalEdits === 0) return 0;

  let writtenCount = 0;
  executeAtomic((edit) => {
    if (writesChords && targetChords !== undefined) applyProjectChords(store, targetChords, edit);
    const ops = writesChords ? buildBatchOps(store, specs, effectiveChords) : preflightOps;
    if (writesChords && ops.length === 0) {
      throw new Error('Generation became empty after applying the target chord stream.');
    }
    const written = new Map<TrackPart, number>();
    for (const op of ops) written.set(op.part, op.apply(edit));
    store.refresh();
    followMotif(store, written);
    writtenCount = ops.length;
  });
  return writtenCount;
}
