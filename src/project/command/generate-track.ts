/**
 * Shared builder for generation commands that lay a fresh line onto a new track.
 *
 * Drums, bass, and counter-melody all create one track carrying one MIDI clip
 * of generated notes. They share the same four wasm-Project edits — addTrack,
 * addClip (source registration + clip insertion), setMidiEvents — so the count
 * lives here as {@link EDITS_PER_TRACK} and the mutation lives in
 * {@link addGeneratedTrack}. The helper reports each native call through the
 * caller's {@link AtomicProjectEdit}, so it must run inside an `executeAtomic`
 * boundary: single-track commands wrap one call, while the batch and
 * full-arrangement commands compose several calls into one transaction. A
 * partial failure then rolls back exactly the calls that completed.
 */

import type { TrackProvenance } from '../generation';
import type { RawNote } from '../midi-events';
import { getProject, notesToProjectEvents, type useProjectStore } from '../store';
import { type NewEditorNote, TRACK_COLOR_PALETTE } from '../types';
import type { AtomicProjectEdit } from './history';

/** The project store instance type (Pinia setup store). */
type ProjectStore = ReturnType<typeof useProjectStore>;

/** Default note-on velocity for generated notes without an explicit one. */
const DEFAULT_VELOCITY = 96;

/**
 * Fills a note-creation payload's optional fields to a full {@link RawNote}
 * (velocity defaults to 96, channel to 0), so generated notes can be written
 * through `setMidiEvents`.
 */
export function materializeNote(note: NewEditorNote): RawNote {
  return {
    pitch: note.pitch,
    startPpq: note.startPpq,
    durationPpq: note.durationPpq,
    velocity: note.velocity ?? DEFAULT_VELOCITY,
    channel: note.channel ?? 0,
  };
}

/** wasm-Project history edits one {@link addGeneratedTrack} call performs. */
export const EDITS_PER_TRACK = 4;

/**
 * A generated part's notes destined for one new track. Part generators build
 * this without touching the Project, so the single-shot command and the batch
 * command can both consume it (each wrapping the write in exactly one
 * `execute`).
 */
export interface TrackPlan {
  /** Display name for the new track and its clip. */
  name: string;
  /** Notes to place, clip-relative (startPpq measured from clip start). */
  notes: RawNote[];
  /** Clip length in PPQ. */
  lengthPpq: number;
  /** NativeSynth preset name for the new track; omitted = the default preset. */
  preset?: string;
  /** How the part was generated, recorded on whichever track receives it. */
  provenance?: TrackProvenance;
}

/** Inputs for {@link addGeneratedTrack}. */
export interface GeneratedTrack {
  /** Display name for the new track and its clip. */
  name: string;
  /** Notes to place, clip-relative (startPpq measured from `startPpq`). */
  notes: ReadonlyArray<RawNote>;
  /** Absolute timeline PPQ of the clip's start. */
  startPpq: number;
  /** Clip length in PPQ. */
  lengthPpq: number;
  /** NativeSynth preset name for the new track; omitted = the default preset. */
  preset?: string;
  /** How the part was generated; recorded on the new track when given. */
  provenance?: TrackProvenance;
}

/**
 * Creates a new MIDI track with one clip of generated notes and mirrors it into
 * the store. Performs exactly {@link EDITS_PER_TRACK} wasm-Project edits, each
 * reported through `edit`, so a mid-sequence native failure rolls back the
 * completed ones and leaves the Project history aligned with the local undo
 * stack. Must run inside an `executeAtomic` boundary.
 *
 * @param store The project store (its `tracks`/`clips` mirror is updated).
 * @param track Track name, notes, and clip placement.
 * @param edit The atomic edit reporter from the enclosing `executeAtomic`.
 * @returns The new clip's id.
 */
export function addGeneratedTrack(
  store: ProjectStore,
  track: GeneratedTrack,
  edit: AtomicProjectEdit,
): number {
  const project = getProject();
  const color = TRACK_COLOR_PALETTE[store.tracks.length % TRACK_COLOR_PALETTE.length];
  const trackId = edit(1, () => project.addTrack({ kind: 'midi', name: track.name }));
  store.tracks = [
    ...store.tracks,
    {
      id: trackId,
      name: track.name,
      color,
      kind: 'midi',
      mute: false,
      solo: false,
      volume: 1,
      pan: 0,
      order: store.tracks.length,
      ...(track.preset !== undefined
        ? { instrument: { kind: 'synth-preset' as const, preset: track.preset } }
        : {}),
      ...(track.provenance !== undefined ? { generated: { ...track.provenance } } : {}),
    },
  ];
  const clipId = edit(2, () =>
    project.addClip({
      trackId,
      isMidi: true,
      startPpq: track.startPpq,
      lengthPpq: track.lengthPpq,
    }),
  );
  store.clips = [
    ...store.clips,
    {
      id: clipId,
      trackId,
      name: track.name,
      startPpq: track.startPpq,
      lengthPpq: track.lengthPpq,
      sourceOffsetPpq: 0,
      gain: 1,
      loopEnabled: false,
      loopLengthPpq: 0,
      notes: [],
    },
  ];
  edit(1, () => project.setMidiEvents(clipId, notesToProjectEvents(track.notes)));
  store.refresh();
  return clipId;
}
