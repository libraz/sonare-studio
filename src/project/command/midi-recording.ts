import { sanitizeCompSegments } from '../comping';
import type { RawNote } from '../midi-events';
import {
  assignMidiLaneFields,
  copyMidiLaneFields,
  joinMidiLaneFields,
  MIDI_LANE_KINDS,
  type MidiLaneField,
  type MidiLaneFields,
} from '../midi-lane-kinds';
import { getProject, notesToProjectEvents, useProjectStore } from '../store';
import type {
  ClipCcLane,
  ClipChannelPressureLane,
  ClipCompSegment,
  ClipPitchBendLane,
  ClipPolyPressureLane,
  ClipProgramChangeLane,
  EditorClip,
  MidiClipTake,
} from '../types';
import { clearLaneRangeWithin, makeRoomForRecordingWithin } from './clip-lane';
import { execute, executeAtomic } from './history';
import {
  requireEditableClip,
  requireEditableTrack,
  windowLanePoints,
  windowMidiNotes,
} from './utils';

/** Copies app-level MIDI take data so callers cannot mutate the clip mirror. */
function cloneMidiTake(take: MidiClipTake): MidiClipTake {
  return {
    name: take.name,
    notes: take.notes.map((note) => ({ ...note })),
    ...copyMidiLaneFields(take),
  };
}

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
  /** Alternative cycle-recording passes. The active pass is written to the playable clip. */
  midiTakes?: ReadonlyArray<MidiClipTake>;
  /** Initially selected take; defaults to the final captured pass. */
  activeMidiTakeIndex?: number;
  /** Clip display name (app-level); defaults to "Clip N". */
  name?: string;
}

/**
 * Lays a freshly recorded performance onto an existing MIDI track as one
 * undoable edit: the clip and its events are committed together so a single
 * undo removes the whole take. Under the disallow overlap policy, clips
 * already under the recorded range are split around it and their covered part
 * removed, so the take always lands; an overlap-allowing project layers it.
 *
 * The notes are clip-window-relative (the caller offsets them by the punch-in
 * position).
 *
 * @param input Clip placement, length, recorded notes and optional name.
 * @returns The new clip id.
 * @throws RangeError when the track is unknown, not a MIDI track, or the
 *   placement is invalid.
 */
export function addRecordedMidiClip(input: AddRecordedMidiClipInput): number {
  return storeRecordedMidiClip(input, makeRoomForRecordingWithin);
}

function storeRecordedMidiClip(
  input: AddRecordedMidiClipInput,
  makeRoom: typeof clearLaneRangeWithin,
): number {
  const store = useProjectStore();
  const track = requireEditableTrack(store, input.trackId);
  if (track.kind !== 'midi') {
    throw new RangeError(`Track ${input.trackId} is not a MIDI track`);
  }
  if (!Number.isFinite(input.startPpq) || input.startPpq < 0) {
    throw new RangeError(`Clip startPpq must be finite and >= 0, got ${input.startPpq}`);
  }
  if (!Number.isFinite(input.lengthPpq) || input.lengthPpq <= 0) {
    throw new RangeError(`Clip lengthPpq must be finite and > 0, got ${input.lengthPpq}`);
  }
  const midiTakes = input.midiTakes?.map(cloneMidiTake);
  const activeMidiTakeIndex =
    midiTakes && midiTakes.length > 0
      ? Math.min(
          Math.max(0, input.activeMidiTakeIndex ?? midiTakes.length - 1),
          midiTakes.length - 1,
        )
      : undefined;
  const activeTake =
    activeMidiTakeIndex === undefined ? undefined : midiTakes?.[activeMidiTakeIndex];
  const notes = activeTake?.notes ?? input.notes;
  const recordedLanes = MIDI_LANE_KINDS.reduce<Record<string, unknown>>((lanes, { field }) => {
    const source = activeTake?.[field] ?? input[field];
    if (source !== undefined) lanes[field] = source;
    return lanes;
  }, {}) as Partial<MidiLaneFields>;
  const project = getProject();
  const events = notesToProjectEvents(notes.map((note) => ({ ...note })));
  return executeAtomic((edit) => {
    makeRoom(edit, input.trackId, input.startPpq, input.startPpq + input.lengthPpq);
    const newClipId = edit(1, () =>
      project.addClip({
        trackId: input.trackId,
        isMidi: true,
        startPpq: input.startPpq,
        lengthPpq: input.lengthPpq,
      }),
    );
    if (events.length > 0) {
      edit(1, () => project.setMidiEvents(newClipId, events));
    }
    if (
      input.name !== undefined ||
      activeTake !== undefined ||
      MIDI_LANE_KINDS.some(({ field }) => input[field] !== undefined)
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
          ...copyMidiLaneFields(recordedLanes),
          ...(midiTakes && midiTakes.length > 0
            ? { midiTakes, midiActiveTakeIndex: activeMidiTakeIndex }
            : {}),
        },
      ];
    }
    store.refresh();
    return newClipId;
  });
}

/** Selects one captured MIDI cycle take and makes it the playable clip content. */
export function setClipMidiActiveTake(clipId: number, takeIndex: number): void {
  const store = useProjectStore();
  const clip = requireEditableClip(store, clipId);
  const clipIndex = store.clips.indexOf(clip);
  if ((clip.kind ?? 'midi') !== 'midi') throw new RangeError(`Clip ${clipId} is not a MIDI clip`);
  const takes = clip.midiTakes;
  if (takes === undefined || takes.length === 0)
    throw new RangeError(`Clip ${clipId} has no MIDI takes`);
  if (!Number.isInteger(takeIndex) || takeIndex < 0 || takeIndex >= takes.length) {
    throw new RangeError(`MIDI take index ${takeIndex} is out of range`);
  }
  const activeTake = cloneMidiTake(takes[takeIndex]);
  const project = getProject();
  execute(1, () => {
    project.setMidiEvents(clipId, notesToProjectEvents(activeTake.notes));
    store.clips = store.clips.map((entry, index) => {
      if (index !== clipIndex) return entry;
      const next: EditorClip = {
        ...entry,
        midiTakes: takes.map(cloneMidiTake),
        midiActiveTakeIndex: takeIndex,
      };
      // A whole take replaces any comp, as one audio take selection does.
      delete next.midiCompSegments;
      const fields = next as Partial<Record<MidiLaneField, unknown>>;
      for (const { field } of MIDI_LANE_KINDS) {
        const lanes = activeTake[field];
        if (lanes !== undefined) fields[field] = lanes;
        else delete fields[field];
      }
      return next;
    });
    store.refresh();
  });
}

/** Rebuilds a MIDI clip from a range-by-range selection of its cycle takes. */
export function setClipMidiCompSegments(
  clipId: number,
  segments: ReadonlyArray<ClipCompSegment>,
): void {
  const store = useProjectStore();
  const clip = requireEditableClip(store, clipId);
  const clipIndex = store.clips.indexOf(clip);
  const takes = clip.midiTakes;
  if (takes === undefined || takes.length === 0)
    throw new RangeError(`Clip ${clipId} has no MIDI takes`);
  const selected = sanitizeCompSegments(segments, takes.length, clip.lengthPpq);
  if (selected.length === 0) throw new RangeError('MIDI comp needs a valid selection');
  // Comp segments are clip-window-local; take notes are source-relative, take lanes clip-window-local.
  const windows = selected.map((segment, i) => ({
    ...takes[segment.takeIndex],
    startPpq: segment.startPpq,
    endPpq: selected[i + 1]?.startPpq ?? clip.lengthPpq,
  }));
  const notes: RawNote[] = windows.flatMap((window) =>
    windowMidiNotes(
      window.notes,
      clip.sourceOffsetPpq + window.startPpq,
      clip.sourceOffsetPpq + window.endPpq,
    ),
  );
  const composed = joinMidiLaneFields(windows, clip.lengthPpq, (points, window, kind) =>
    windowLanePoints(kind, points, window.startPpq, window.endPpq),
  );
  const project = getProject();
  execute(1, () => {
    project.setMidiEvents(clipId, notesToProjectEvents(notes));
    store.clips = store.clips.map((entry, index) => {
      if (index !== clipIndex) return entry;
      const next: EditorClip = {
        ...entry,
        midiTakes: takes.map(cloneMidiTake),
        midiCompSegments: selected,
      };
      assignMidiLaneFields(next, composed);
      return next;
    });
    store.refresh();
  });
}

/** Commits the current MIDI comp by removing its reversible take metadata. */
export function flattenClipMidiComp(clipId: number): void {
  const store = useProjectStore();
  const clip = requireEditableClip(store, clipId);
  const index = store.clips.indexOf(clip);
  if ((clip.midiTakes?.length ?? 0) === 0) throw new RangeError(`Clip ${clipId} has no MIDI takes`);
  execute(0, () => {
    store.clips = store.clips.map((entry, entryIndex) => {
      if (entryIndex !== index) return entry;
      const {
        midiTakes: _midiTakes,
        midiActiveTakeIndex: _active,
        midiCompSegments: _comp,
        ...base
      } = entry;
      return base;
    });
    store.refresh();
  });
}

/**
 * Replaces MIDI material in one timeline interval as one atomic command.
 *
 * Existing clips are split at the interval edges and their middle fragments
 * are removed, leaving material before and after the cycle untouched; the new
 * recording is then added as one MIDI clip in the same history entry.
 */
export function overwriteRecordedMidiClip(input: AddRecordedMidiClipInput): number {
  return storeRecordedMidiClip(input, clearLaneRangeWithin);
}

/** Descriptive alias for callers that use the replace terminology. */
export const replaceRecordedMidiMaterial = overwriteRecordedMidiClip;
