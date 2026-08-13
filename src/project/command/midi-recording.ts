import { sanitizeCompSegments } from '../comping';
import type { RawNote } from '../midi-events';
import { getProject, notesToProjectEvents, useProjectStore } from '../store';
import type {
  ClipCcLane,
  ClipChannelPressureLane,
  ClipCompSegment,
  ClipPitchBendLane,
  ClipPolyPressureLane,
  ClipProgramChangeLane,
  MidiClipTake,
} from '../types';
import { removeClipWithin, splitClipWithin } from './clips-internal';
import { execute, executeAtomic } from './history';
import { requireTrack } from './utils';

/** Copies app-level MIDI take data so callers cannot mutate the clip mirror. */
function cloneMidiTake(take: MidiClipTake): MidiClipTake {
  return {
    name: take.name,
    notes: take.notes.map((note) => ({ ...note })),
    ...(take.ccLanes !== undefined
      ? {
          ccLanes: take.ccLanes.map((lane) => ({
            ...lane,
            points: lane.points.map((point) => ({ ...point })),
          })),
        }
      : {}),
    ...(take.pitchBendLanes !== undefined
      ? {
          pitchBendLanes: take.pitchBendLanes.map((lane) => ({
            ...lane,
            points: lane.points.map((point) => ({ ...point })),
          })),
        }
      : {}),
    ...(take.programChangeLanes !== undefined
      ? {
          programChangeLanes: take.programChangeLanes.map((lane) => ({
            ...lane,
            points: lane.points.map((point) => ({ ...point })),
          })),
        }
      : {}),
    ...(take.channelPressureLanes !== undefined
      ? {
          channelPressureLanes: take.channelPressureLanes.map((lane) => ({
            ...lane,
            points: lane.points.map((point) => ({ ...point })),
          })),
        }
      : {}),
    ...(take.polyPressureLanes !== undefined
      ? {
          polyPressureLanes: take.polyPressureLanes.map((lane) => ({
            ...lane,
            points: lane.points.map((point) => ({ ...point })),
          })),
        }
      : {}),
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
  const project = getProject();
  const events = notesToProjectEvents(notes.map((note) => ({ ...note })));
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
      activeTake !== undefined ||
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
          ...(activeTake?.ccLanes !== undefined || input.ccLanes !== undefined
            ? {
                ccLanes: (activeTake?.ccLanes ?? input.ccLanes ?? []).map((lane) => ({
                  ...lane,
                  points: lane.points.map((p) => ({ ...p })),
                })),
              }
            : {}),
          ...(activeTake?.pitchBendLanes !== undefined || input.pitchBendLanes !== undefined
            ? {
                pitchBendLanes: (activeTake?.pitchBendLanes ?? input.pitchBendLanes ?? []).map(
                  (lane) => ({
                    ...lane,
                    points: lane.points.map((p) => ({ ...p })),
                  }),
                ),
              }
            : {}),
          ...(activeTake?.programChangeLanes !== undefined || input.programChangeLanes !== undefined
            ? {
                programChangeLanes: (
                  activeTake?.programChangeLanes ??
                  input.programChangeLanes ??
                  []
                ).map((lane) => ({
                  ...lane,
                  points: lane.points.map((p) => ({ ...p })),
                })),
              }
            : {}),
          ...(activeTake?.channelPressureLanes !== undefined ||
          input.channelPressureLanes !== undefined
            ? {
                channelPressureLanes: (
                  activeTake?.channelPressureLanes ??
                  input.channelPressureLanes ??
                  []
                ).map((lane) => ({
                  ...lane,
                  points: lane.points.map((p) => ({ ...p })),
                })),
              }
            : {}),
          ...(activeTake?.polyPressureLanes !== undefined || input.polyPressureLanes !== undefined
            ? {
                polyPressureLanes: (
                  activeTake?.polyPressureLanes ??
                  input.polyPressureLanes ??
                  []
                ).map((lane) => ({
                  ...lane,
                  points: lane.points.map((p) => ({ ...p })),
                })),
              }
            : {}),
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
  const clipIndex = store.clips.findIndex((clip) => clip.id === clipId);
  if (clipIndex < 0) throw new RangeError(`Unknown clip ${clipId}`);
  const clip = store.clips[clipIndex];
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
      const {
        ccLanes: _ccLanes,
        pitchBendLanes: _pitchBendLanes,
        programChangeLanes: _programChangeLanes,
        channelPressureLanes: _channelPressureLanes,
        polyPressureLanes: _polyPressureLanes,
        ...base
      } = entry;
      return {
        ...base,
        midiTakes: takes.map(cloneMidiTake),
        midiActiveTakeIndex: takeIndex,
        ...(activeTake.ccLanes !== undefined ? { ccLanes: activeTake.ccLanes } : {}),
        ...(activeTake.pitchBendLanes !== undefined
          ? { pitchBendLanes: activeTake.pitchBendLanes }
          : {}),
        ...(activeTake.programChangeLanes !== undefined
          ? { programChangeLanes: activeTake.programChangeLanes }
          : {}),
        ...(activeTake.channelPressureLanes !== undefined
          ? { channelPressureLanes: activeTake.channelPressureLanes }
          : {}),
        ...(activeTake.polyPressureLanes !== undefined
          ? { polyPressureLanes: activeTake.polyPressureLanes }
          : {}),
      };
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
  const clipIndex = store.clips.findIndex((clip) => clip.id === clipId);
  if (clipIndex < 0) throw new RangeError(`Unknown clip ${clipId}`);
  const clip = store.clips[clipIndex];
  const takes = clip.midiTakes;
  if (takes === undefined || takes.length === 0)
    throw new RangeError(`Clip ${clipId} has no MIDI takes`);
  const selected = sanitizeCompSegments(segments, takes.length, clip.lengthPpq);
  if (selected.length === 0) throw new RangeError('MIDI comp needs a valid selection');
  const notes: RawNote[] = [];
  for (let i = 0; i < selected.length; i++) {
    const start = selected[i].startPpq;
    const end = selected[i + 1]?.startPpq ?? clip.lengthPpq;
    // MIDI take notes use the clip's source-relative coordinate frame, while
    // comp segments are relative to the audible clip window. Offset only the
    // note comparison; expression lanes below are already clip-window-local.
    const sourceStart = clip.sourceOffsetPpq + start;
    const sourceEnd = clip.sourceOffsetPpq + end;
    for (const note of takes[selected[i].takeIndex].notes) {
      const noteStart = Math.max(sourceStart, note.startPpq);
      const noteEnd = Math.min(sourceEnd, note.startPpq + note.durationPpq);
      if (noteEnd > noteStart)
        notes.push({ ...note, startPpq: noteStart, durationPpq: noteEnd - noteStart });
    }
  }
  const composeLanes = <Lane extends { points: Array<{ ppq: number }> }>(
    getLanes: (take: MidiClipTake) => Lane[] | undefined,
  ): Lane[] => {
    const out: Lane[] = [];
    for (let i = 0; i < selected.length; i++) {
      const start = selected[i].startPpq;
      const end = selected[i + 1]?.startPpq ?? clip.lengthPpq;
      for (const lane of getLanes(takes[selected[i].takeIndex]) ?? []) {
        const points = lane.points.filter((point) => point.ppq >= start && point.ppq < end);
        const previous = lane.points.filter((point) => point.ppq < start).at(-1);
        const rebased = [
          ...(previous === undefined ? [] : [{ ...previous, ppq: start }]),
          ...points.map((point) => ({ ...point })),
        ];
        if (rebased.length > 0) out.push({ ...lane, points: rebased });
      }
    }
    return out;
  };
  const ccLanes = composeLanes((take) => take.ccLanes);
  const pitchBendLanes = composeLanes((take) => take.pitchBendLanes);
  const programChangeLanes = composeLanes((take) => take.programChangeLanes);
  const channelPressureLanes = composeLanes((take) => take.channelPressureLanes);
  const polyPressureLanes = composeLanes((take) => take.polyPressureLanes);
  const project = getProject();
  execute(1, () => {
    project.setMidiEvents(clipId, notesToProjectEvents(notes));
    store.clips = store.clips.map((entry, index) => {
      if (index !== clipIndex) return entry;
      const {
        ccLanes: _ccLanes,
        pitchBendLanes: _pitchBendLanes,
        programChangeLanes: _programChangeLanes,
        channelPressureLanes: _channelPressureLanes,
        polyPressureLanes: _polyPressureLanes,
        ...base
      } = entry;
      return {
        ...base,
        midiTakes: takes.map(cloneMidiTake),
        midiCompSegments: selected,
        ...(ccLanes.length > 0 ? { ccLanes } : {}),
        ...(pitchBendLanes.length > 0 ? { pitchBendLanes } : {}),
        ...(programChangeLanes.length > 0 ? { programChangeLanes } : {}),
        ...(channelPressureLanes.length > 0 ? { channelPressureLanes } : {}),
        ...(polyPressureLanes.length > 0 ? { polyPressureLanes } : {}),
      };
    });
    store.refresh();
  });
}

/** Commits the current MIDI comp by removing its reversible take metadata. */
export function flattenClipMidiComp(clipId: number): void {
  const store = useProjectStore();
  const index = store.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) throw new RangeError(`Unknown clip ${clipId}`);
  const clip = store.clips[index];
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
 * are removed, leaving material before and after the cycle untouched. The new
 * recording is then added as one MIDI clip in the same atomic history entry.
 * This keeps overwrite distinct from keep-last, which merely commits another
 * overlapping recording clip.
 */
export function overwriteRecordedMidiClip(input: AddRecordedMidiClipInput): number {
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
  const intervalStart = input.startPpq;
  const intervalEnd = input.startPpq + input.lengthPpq;
  if (!Number.isFinite(intervalEnd) || intervalEnd <= intervalStart) {
    throw new RangeError('MIDI overwrite interval must have a finite positive length');
  }
  const project = getProject();
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
  const events = notesToProjectEvents(notes.map((note) => ({ ...note })));

  return executeAtomic((edit) => {
    // Snapshot ids first: splitting inserts right-hand clips into the mirror,
    // but each original clip is handled independently.
    const overlapping = store.clips
      .filter(
        (clip) =>
          clip.trackId === input.trackId &&
          (clip.kind ?? 'midi') === 'midi' &&
          (clip.notes.length > 0 ||
            clip.ccLanes?.some((lane) => lane.points.length > 0) === true ||
            clip.pitchBendLanes?.some((lane) => lane.points.length > 0) === true ||
            clip.programChangeLanes?.some((lane) => lane.points.length > 0) === true ||
            clip.channelPressureLanes?.some((lane) => lane.points.length > 0) === true ||
            clip.polyPressureLanes?.some((lane) => lane.points.length > 0) === true) &&
          clip.startPpq < intervalEnd &&
          clip.startPpq + clip.lengthPpq > intervalStart,
      )
      .map((clip) => clip.id);
    for (const clipId of overlapping) {
      const source = store.clips.find((clip) => clip.id === clipId);
      if (source === undefined) continue;
      const overlapStart = Math.max(intervalStart, source.startPpq);
      const overlapEnd = Math.min(intervalEnd, source.startPpq + source.lengthPpq);
      if (overlapEnd <= overlapStart) continue;
      let middleId = clipId;
      if (source.startPpq < overlapStart) {
        middleId = splitClipWithin(edit, middleId, overlapStart);
      }
      const middle = store.clips.find((clip) => clip.id === middleId);
      if (middle === undefined) continue;
      if (middle.startPpq + middle.lengthPpq > overlapEnd) {
        splitClipWithin(edit, middleId, overlapEnd);
      }
      removeClipWithin(edit, middleId);
    }

    // Project.addClip records source registration and clip creation as two
    // native edits (the same accounting used by addRecordedMidiClip).
    const newClipId = edit(2, () =>
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
      input.ccLanes !== undefined ||
      input.pitchBendLanes !== undefined ||
      input.programChangeLanes !== undefined ||
      input.channelPressureLanes !== undefined ||
      input.polyPressureLanes !== undefined
    ) {
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
          ...(activeTake?.ccLanes !== undefined || input.ccLanes !== undefined
            ? {
                ccLanes: (activeTake?.ccLanes ?? input.ccLanes ?? []).map((lane) => ({
                  ...lane,
                  points: lane.points.map((point) => ({ ...point })),
                })),
              }
            : {}),
          ...(activeTake?.pitchBendLanes !== undefined || input.pitchBendLanes !== undefined
            ? {
                pitchBendLanes: (activeTake?.pitchBendLanes ?? input.pitchBendLanes ?? []).map(
                  (lane) => ({
                    ...lane,
                    points: lane.points.map((point) => ({ ...point })),
                  }),
                ),
              }
            : {}),
          ...(activeTake?.programChangeLanes !== undefined || input.programChangeLanes !== undefined
            ? {
                programChangeLanes: (
                  activeTake?.programChangeLanes ??
                  input.programChangeLanes ??
                  []
                ).map((lane) => ({
                  ...lane,
                  points: lane.points.map((point) => ({ ...point })),
                })),
              }
            : {}),
          ...(activeTake?.channelPressureLanes !== undefined ||
          input.channelPressureLanes !== undefined
            ? {
                channelPressureLanes: (
                  activeTake?.channelPressureLanes ??
                  input.channelPressureLanes ??
                  []
                ).map((lane) => ({
                  ...lane,
                  points: lane.points.map((point) => ({ ...point })),
                })),
              }
            : {}),
          ...(activeTake?.polyPressureLanes !== undefined || input.polyPressureLanes !== undefined
            ? {
                polyPressureLanes: (
                  activeTake?.polyPressureLanes ??
                  input.polyPressureLanes ??
                  []
                ).map((lane) => ({
                  ...lane,
                  points: lane.points.map((point) => ({ ...point })),
                })),
              }
            : {}),
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

/** Descriptive alias for callers that use the replace terminology. */
export const replaceRecordedMidiMaterial = overwriteRecordedMidiClip;
