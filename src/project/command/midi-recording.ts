import type { RawNote } from '../midi-events';
import { getProject, notesToProjectEvents, useProjectStore } from '../store';
import type {
  ClipCcLane,
  ClipChannelPressureLane,
  ClipPitchBendLane,
  ClipPolyPressureLane,
  ClipProgramChangeLane,
} from '../types';
import { execute } from './history';
import { requireTrack } from './utils';

/** Fields for {@link addRecordedMidiClip}. */
export interface AddRecordedMidiClipInput {
  /** Id of the MIDI track the clip belongs to. */
  trackId: number;
  /** Timeline start in PPQ (>= 0). */
  startPpq: number;
  /** Clip length in PPQ (> 0). */
  lengthPpq: number;
  /** Recorded notes, relative to the clip window (startPpq from 0). */
  notes: ReadonlyArray<RawNote>;
  /** Recorded continuous-controller lanes, relative to the clip window. */
  ccLanes?: ReadonlyArray<ClipCcLane>;
  /** Recorded pitch-bend lanes, relative to the clip window. */
  pitchBendLanes?: ReadonlyArray<ClipPitchBendLane>;
  /** Recorded program-change lanes, relative to the clip window. */
  programChangeLanes?: ReadonlyArray<ClipProgramChangeLane>;
  /** Recorded channel-pressure lanes, relative to the clip window. */
  channelPressureLanes?: ReadonlyArray<ClipChannelPressureLane>;
  /** Recorded polyphonic key-pressure lanes, relative to the clip window. */
  polyPressureLanes?: ReadonlyArray<ClipPolyPressureLane>;
  /** Clip display name (app-level); defaults to "Clip N". */
  name?: string;
}

/**
 * Lays a freshly recorded performance onto an existing MIDI track as one
 * undoable edit: the clip and its events are committed together so a single
 * undo removes the whole take.
 *
 * The notes are clip-window-relative (the caller offsets them by the punch-in
 * position). The clip and its events are two/one wasm-Project edits committed
 * inside a single `execute`.
 *
 * @param input Clip placement, length, recorded notes and optional name.
 * @returns The new clip id.
 * @throws RangeError when the track is unknown, not a MIDI track, or the
 *   placement is invalid.
 */
export function addRecordedMidiClip(input: AddRecordedMidiClipInput): number {
  const store = useProjectStore();
  const track = requireTrack(store, input.trackId);
  if (track.kind !== 'midi') {
    throw new RangeError(`Track ${input.trackId} is not a MIDI track`);
  }
  if (!Number.isFinite(input.startPpq) || input.startPpq < 0) {
    throw new RangeError(`Clip startPpq must be finite and >= 0, got ${input.startPpq}`);
  }
  if (!Number.isFinite(input.lengthPpq) || input.lengthPpq <= 0) {
    throw new RangeError(`Clip lengthPpq must be finite and > 0, got ${input.lengthPpq}`);
  }
  const project = getProject();
  const events = notesToProjectEvents(input.notes.map((note) => ({ ...note })));
  // addClip/midi (2) + setMidiEvents (1, only when there are notes).
  const editCount = events.length > 0 ? 3 : 2;
  return execute(editCount, () => {
    const newClipId = project.addClip({
      trackId: input.trackId,
      isMidi: true,
      startPpq: input.startPpq,
      lengthPpq: input.lengthPpq,
    });
    if (events.length > 0) {
      project.setMidiEvents(newClipId, events);
    }
    if (
      input.name !== undefined ||
      input.ccLanes !== undefined ||
      input.pitchBendLanes !== undefined ||
      input.programChangeLanes !== undefined ||
      input.channelPressureLanes !== undefined ||
      input.polyPressureLanes !== undefined
    ) {
      // Seed the mirror entry so refresh keeps the app-level name; refresh
      // rebuilds the notes from the Project.
      store.clips = [
        ...store.clips,
        {
          id: newClipId,
          trackId: input.trackId,
          name: input.name ?? `Clip ${newClipId}`,
          startPpq: input.startPpq,
          lengthPpq: input.lengthPpq,
          sourceOffsetPpq: 0,
          gain: 1,
          loopEnabled: false,
          loopLengthPpq: 0,
          notes: [],
          ...(input.ccLanes !== undefined
            ? {
                ccLanes: input.ccLanes.map((lane) => ({
                  ...lane,
                  points: lane.points.map((p) => ({ ...p })),
                })),
              }
            : {}),
          ...(input.pitchBendLanes !== undefined
            ? {
                pitchBendLanes: input.pitchBendLanes.map((lane) => ({
                  ...lane,
                  points: lane.points.map((p) => ({ ...p })),
                })),
              }
            : {}),
          ...(input.programChangeLanes !== undefined
            ? {
                programChangeLanes: input.programChangeLanes.map((lane) => ({
                  ...lane,
                  points: lane.points.map((p) => ({ ...p })),
                })),
              }
            : {}),
          ...(input.channelPressureLanes !== undefined
            ? {
                channelPressureLanes: input.channelPressureLanes.map((lane) => ({
                  ...lane,
                  points: lane.points.map((p) => ({ ...p })),
                })),
              }
            : {}),
          ...(input.polyPressureLanes !== undefined
            ? {
                polyPressureLanes: input.polyPressureLanes.map((lane) => ({
                  ...lane,
                  points: lane.points.map((p) => ({ ...p })),
                })),
              }
            : {}),
        },
      ];
    }
    store.refresh();
    return newClipId;
  });
}
