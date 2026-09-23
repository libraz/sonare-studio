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

import type { TrackPart } from '../generation';
import { getProject, notesToProjectEvents, useProjectStore } from '../store';
import { buildBackingPlan, type GenerateBackingParams } from './generate-backing';
import { buildBassPlan, type GenerateBassParams } from './generate-bass';
import { buildCounterPlan, type GenerateCounterMelodyParams } from './generate-counter-melody';
import { buildDrumsPlan, type GenerateDrumsParams } from './generate-drums';
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
  /** Motif only: write into the active MIDI clip. */
  | { kind: 'clip'; mode: 'append' | 'replace' };

/** One selected part with its parameters and write target. */
export type BatchPartSpec =
  | { part: 'motif'; params: GenerateMotifParams; target: BatchTarget }
  | { part: 'drums'; params: GenerateDrumsParams; target: BatchTarget }
  | { part: 'bass'; params: GenerateBassParams; target: BatchTarget }
  | { part: 'counter'; params: GenerateCounterMelodyParams; target: BatchTarget }
  | { part: 'backing'; params: GenerateBackingParams; target: BatchTarget };

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
function planFor(store: ReturnType<typeof useProjectStore>, spec: BatchPartSpec): TrackPlan | null {
  switch (spec.part) {
    case 'motif':
      return buildMotifPlan(store, spec.params);
    case 'drums':
      return buildDrumsPlan(store, spec.params);
    case 'bass':
      return buildBassPlan(store, spec.params);
    case 'counter':
      return buildCounterPlan(store, spec.params);
    case 'backing':
      return buildBackingPlan(store, spec.params);
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

/**
 * Generates the selected parts in one undoable transaction.
 *
 * @param specs The parts to generate, each with its parameters and target.
 * @returns The number of parts actually written (empty generations are
 *   skipped).
 */
export function generateTracksBatchCommand(specs: ReadonlyArray<BatchPartSpec>): number {
  const store = useProjectStore();
  const project = getProject();
  const ops: BatchOp[] = [];

  for (const spec of specs) {
    if (spec.target.kind === 'clip') {
      if (spec.part !== 'motif') continue;
      const clip = store.activeClip;
      if (clip === null) continue;
      requireEditableClip(store, clip.id);
      const mode = spec.target.mode;
      const merged = buildMotifClipMerge(store, clip, spec.params, mode);
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

    const plan = planFor(store, spec);
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

  const totalEdits = ops.reduce((sum, op) => sum + op.edits, 0);
  if (totalEdits === 0) return 0;

  executeAtomic((edit) => {
    const written = new Map<TrackPart, number>();
    for (const op of ops) written.set(op.part, op.apply(edit));
    store.refresh();
    followMotif(store, written);
  });
  return ops.length;
}
