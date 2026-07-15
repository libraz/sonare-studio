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
 */

import { getProject, notesToProjectEvents, useProjectStore } from '../store';
import { buildBackingPlan, type GenerateBackingParams } from './generate-backing';
import { buildBassPlan, type GenerateBassParams } from './generate-bass';
import { buildCounterPlan, type GenerateCounterMelodyParams } from './generate-counter-melody';
import { buildDrumsPlan, type GenerateDrumsParams } from './generate-drums';
import { buildMotifClipMerge, buildMotifPlan, type GenerateMotifParams } from './generate-motif';
import { addGeneratedTrack, EDITS_PER_TRACK, type TrackPlan } from './generate-track';
import { execute } from './history';

/** The five instrumental parts the batch command can generate. */
export type TrackPart = 'motif' | 'drums' | 'bass' | 'counter' | 'backing';

/** Canonical generated-track name per part, used by the name heuristic. */
const PART_TRACK_NAMES: Record<TrackPart, string> = {
  motif: 'Motif',
  drums: 'Drums',
  bass: 'Bass',
  counter: 'Counter melody',
  backing: 'Backing',
};

/**
 * Classifies an existing track as a replacement candidate for a part by its
 * name (the degraded provenance heuristic — no persisted generation origin).
 *
 * @returns The matching part, or null when the name matches none.
 */
export function partForTrackName(name: string): TrackPart | null {
  const normalized = name.trim().toLowerCase();
  for (const part of Object.keys(PART_TRACK_NAMES) as TrackPart[]) {
    if (PART_TRACK_NAMES[part].toLowerCase() === normalized) return part;
  }
  return null;
}

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
  edits: number;
  apply: () => void;
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
): void {
  const track = store.tracks.find((entry) => entry.id === trackId);
  if (track?.kind !== 'midi') {
    throw new RangeError(`Generated content can only replace an existing MIDI track: ${trackId}`);
  }
  const oldClips = store.clips.filter((clip) => clip.trackId === trackId);
  for (const clip of oldClips) getProject().removeClip(clip.id);
  const clipId = getProject().addClip({
    trackId,
    isMidi: true,
    startPpq: 0,
    lengthPpq: plan.lengthPpq,
  });
  getProject().setMidiEvents(clipId, notesToProjectEvents(plan.notes));
  store.refresh();
  store.clips = store.clips.map((clip) =>
    clip.id === clipId ? { ...clip, name: track.name } : clip,
  );
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
      const mode = spec.target.mode;
      const merged = buildMotifClipMerge(store, clip, spec.params, mode);
      if (merged === null) continue;
      ops.push({
        edits: 1,
        apply: () => {
          project.setMidiEvents(clip.id, notesToProjectEvents(merged));
        },
      });
      continue;
    }

    const plan = planFor(store, spec);
    if (plan === null) continue;

    if (spec.target.kind === 'replaceTrack') {
      const trackId = spec.target.trackId;
      const existing = store.tracks.find((track) => track.id === trackId);
      if (existing && existing.kind !== 'midi') {
        throw new RangeError(
          `Generated content can only replace an existing MIDI track: ${trackId}`,
        );
      }
      const oldClipCount = store.clips.filter((clip) => clip.trackId === trackId).length;
      ops.push({
        edits: existing ? oldClipCount + 3 : EDITS_PER_TRACK,
        apply: () => {
          if (existing) replaceTrack(store, trackId, plan);
          else
            addGeneratedTrack(store, {
              name: plan.name,
              notes: plan.notes,
              startPpq: 0,
              lengthPpq: plan.lengthPpq,
              preset: plan.preset,
            });
        },
      });
      continue;
    }

    ops.push({
      edits: EDITS_PER_TRACK,
      apply: () =>
        addGeneratedTrack(store, {
          name: plan.name,
          notes: plan.notes,
          startPpq: 0,
          lengthPpq: plan.lengthPpq,
          preset: plan.preset,
        }),
    });
  }

  const totalEdits = ops.reduce((sum, op) => sum + op.edits, 0);
  if (totalEdits === 0) return 0;

  execute(totalEdits, () => {
    for (const op of ops) op.apply();
    store.refresh();
  });
  return ops.length;
}
