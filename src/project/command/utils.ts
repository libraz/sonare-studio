import { sanitizeCompSegments } from '../comping';
import { cloneCcLanes } from '../midi-cc';
import type { useProjectStore } from '../store';
import type {
  ClipChannelPressureLane,
  ClipCompSegment,
  ClipPitchBendLane,
  ClipPolyPressureLane,
  ClipPressurePoint,
  ClipProgramChangeLane,
  ClipWarp,
  EditorClip,
  EditorTrack,
  MidiClipTake,
  SmfSysExPacket,
} from '../types';
import { sanitizeWarpAnchors, warpSourceSecondsAt } from '../warp';

/** Throws RangeError when a PPQ value is not finite or negative. */
export function validatePpq(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and >= 0, got ${value}`);
  }
}

/** Returns the mirror track with the given id, or throws RangeError. */
export function requireTrack(
  store: ReturnType<typeof useProjectStore>,
  trackId: number,
): EditorTrack {
  const track = store.tracks.find((t) => t.id === trackId);
  if (!track) throw new RangeError(`Unknown track id: ${trackId}`);
  return track;
}

/** Returns the mirror clip with the given id, or throws RangeError. */
export function requireClip(store: ReturnType<typeof useProjectStore>, clipId: number): EditorClip {
  const clip = store.clips.find((c) => c.id === clipId);
  if (!clip) throw new RangeError(`Unknown clip id: ${clipId}`);
  return clip;
}

/** Throws when a track's baked render currently owns playback of its content. */
export function requireEditableTrack(
  store: ReturnType<typeof useProjectStore>,
  trackId: number,
): EditorTrack {
  const track = requireTrack(store, trackId);
  if (track.frozen !== undefined) {
    throw new Error(`Track ${trackId} is frozen; unfreeze it before editing its clips or notes`);
  }
  return track;
}

/** Returns a clip only when its owning track is not frozen. */
export function requireEditableClip(
  store: ReturnType<typeof useProjectStore>,
  clipId: number,
): EditorClip {
  const clip = requireClip(store, clipId);
  requireEditableTrack(store, clip.trackId);
  return clip;
}

/**
 * Copies app-level audio metadata (kind, asset reference) from a source clip
 * onto a derived clip mirror entry (duplicate/split results). Fades are not
 * copied: the Project owns them for clips it derives.
 */
export function withAudioMetadata(target: EditorClip, source: EditorClip): EditorClip {
  if (source.kind === undefined && source.assetId === undefined) return target;
  const next: EditorClip = { ...target };
  if (source.kind !== undefined) next.kind = source.kind;
  if (source.assetId !== undefined) next.assetId = source.assetId;
  return next;
}

interface DerivedClipMetadataOptions {
  /** Source-window PPQ that becomes 0 in the derived clip. */
  windowStartPpq?: number;
  /** Length of the derived clip window. */
  windowLengthPpq?: number;
}

interface PpqPoint {
  ppq: number;
}

function clampedTakeIndex(index: number | undefined, takeCount: number): number {
  if (takeCount <= 0) return 0;
  const candidate = Number.isFinite(index) ? Math.floor(index as number) : takeCount - 1;
  return Math.min(Math.max(0, candidate), takeCount - 1);
}

function transformLanePoints<T extends PpqPoint>(
  points: ReadonlyArray<T>,
  windowStartPpq: number,
  windowLengthPpq: number,
): T[] {
  const length = Number.isFinite(windowLengthPpq) && windowLengthPpq > 0 ? windowLengthPpq : 0;
  const windowEndPpq = windowStartPpq + length;
  const byPpq = new Map<number, T>();
  let held: T | undefined;
  for (const point of points) {
    if (!Number.isFinite(point.ppq)) continue;
    if (point.ppq < windowStartPpq) {
      if (!held || point.ppq >= held.ppq) held = point;
      continue;
    }
    if (point.ppq > windowEndPpq) continue;
    byPpq.set(point.ppq - windowStartPpq, { ...point, ppq: point.ppq - windowStartPpq });
  }
  if (held && !byPpq.has(0)) byPpq.set(0, { ...held, ppq: 0 });
  return [...byPpq.values()].sort((a, b) => a.ppq - b.ppq);
}

function transformLaneList<T extends { points: ReadonlyArray<PpqPoint> }>(
  lanes: ReadonlyArray<T> | undefined,
  windowStartPpq: number,
  windowLengthPpq: number,
): T[] | undefined {
  const transformed = lanes?.map((lane) => ({
    ...lane,
    points: transformLanePoints(lane.points, windowStartPpq, windowLengthPpq),
  })) as T[] | undefined;
  return transformed?.filter((lane) => lane.points.length > 0);
}

/**
 * Keeps MIDI take notes in the source-relative coordinate frame while
 * clipping them to the derived source window. The native Project uses this
 * same frame for clip notes after a split/trim; rebasing them to zero would
 * make switching the derived clip's active take play at the wrong source
 * offset.
 */
function transformMidiTakeNotes(
  notes: MidiClipTake['notes'],
  sourceWindowStartPpq: number,
  sourceWindowEndPpq: number,
): MidiClipTake['notes'] {
  const transformed: MidiClipTake['notes'] = [];
  for (const note of notes) {
    if (!Number.isFinite(note.startPpq) || !Number.isFinite(note.durationPpq)) continue;
    const start = Math.max(note.startPpq, sourceWindowStartPpq);
    const end = Math.min(note.startPpq + note.durationPpq, sourceWindowEndPpq);
    if (!(end > start)) continue;
    transformed.push({ ...note, startPpq: start, durationPpq: end - start });
  }
  return transformed.sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch);
}

function transformMidiTake(
  take: MidiClipTake,
  sourceWindowStartPpq: number,
  sourceWindowEndPpq: number,
  windowStartPpq: number,
  windowLengthPpq: number,
): MidiClipTake {
  const next: MidiClipTake = {
    name: take.name,
    notes: transformMidiTakeNotes(take.notes, sourceWindowStartPpq, sourceWindowEndPpq),
  };
  const ccLanes = transformLaneList(take.ccLanes, windowStartPpq, windowLengthPpq);
  if (ccLanes !== undefined && ccLanes.length > 0) next.ccLanes = ccLanes;
  const pitchBendLanes = transformLaneList(take.pitchBendLanes, windowStartPpq, windowLengthPpq);
  if (pitchBendLanes !== undefined && pitchBendLanes.length > 0) {
    next.pitchBendLanes = pitchBendLanes;
  }
  const programChangeLanes = transformLaneList(
    take.programChangeLanes,
    windowStartPpq,
    windowLengthPpq,
  );
  if (programChangeLanes !== undefined && programChangeLanes.length > 0) {
    next.programChangeLanes = programChangeLanes;
  }
  const channelPressureLanes = transformLaneList(
    take.channelPressureLanes,
    windowStartPpq,
    windowLengthPpq,
  );
  if (channelPressureLanes !== undefined && channelPressureLanes.length > 0) {
    next.channelPressureLanes = channelPressureLanes;
  }
  const polyPressureLanes = transformLaneList(
    take.polyPressureLanes,
    windowStartPpq,
    windowLengthPpq,
  );
  if (polyPressureLanes !== undefined && polyPressureLanes.length > 0) {
    next.polyPressureLanes = polyPressureLanes;
  }
  return next;
}

function transformTakeCompSegments(
  segments: ReadonlyArray<ClipCompSegment> | undefined,
  takeCount: number,
  defaultTakeIndex: number,
  sourceLengthPpq: number,
  windowStartPpq: number,
  windowLengthPpq: number,
): ClipCompSegment[] {
  const current = sanitizeCompSegments(
    segments && segments.length > 0 ? segments : [{ startPpq: 0, takeIndex: defaultTakeIndex }],
    takeCount,
    sourceLengthPpq,
  );
  const windowEndPpq = windowStartPpq + windowLengthPpq;
  let firstSource = current[0];
  for (const segment of current) {
    if (segment.startPpq <= windowStartPpq) firstSource = segment;
    else break;
  }
  const first: ClipCompSegment = {
    startPpq: 0,
    takeIndex: firstSource?.takeIndex ?? defaultTakeIndex,
    ...(firstSource?.startPpq === windowStartPpq && firstSource.crossfadePpq !== undefined
      ? { crossfadePpq: firstSource.crossfadePpq }
      : {}),
  };
  const next = [
    first,
    ...current
      .filter((segment) => segment.startPpq > windowStartPpq && segment.startPpq < windowEndPpq)
      .map((segment) => ({
        startPpq: segment.startPpq - windowStartPpq,
        takeIndex: segment.takeIndex,
        ...(segment.crossfadePpq !== undefined ? { crossfadePpq: segment.crossfadePpq } : {}),
      })),
  ];
  return sanitizeCompSegments(next, takeCount, windowLengthPpq);
}

function transformCompSegments(
  source: EditorClip,
  windowStartPpq: number,
  windowLengthPpq: number,
): ClipCompSegment[] | undefined {
  const takes = source.takes;
  if (takes === undefined || takes.length === 0) return undefined;
  return transformTakeCompSegments(
    source.compSegments,
    takes.length,
    0,
    source.lengthPpq,
    windowStartPpq,
    windowLengthPpq,
  );
}

function transformWarp(
  source: EditorClip,
  target: EditorClip,
  windowStartPpq: number,
  windowLengthPpq: number,
): ClipWarp | undefined {
  const warp = source.warp;
  if (warp === undefined) return undefined;
  const secondsPerSourcePpq = warp.sourceBpm > 0 ? 60 / warp.sourceBpm : 0;
  const sourceStartSeconds = warpSourceSecondsAt(source, windowStartPpq);
  const sourceEndSeconds = warpSourceSecondsAt(source, windowStartPpq + windowLengthPpq);
  const linearStartSeconds = target.sourceOffsetPpq * secondsPerSourcePpq;
  const linearEndSeconds = (target.sourceOffsetPpq + windowLengthPpq) * secondsPerSourcePpq;
  const shiftSeconds = sourceStartSeconds ?? linearStartSeconds;
  const anchors = sanitizeWarpAnchors(
    (warp.anchors ?? [])
      .filter(
        (anchor) => anchor.ppq > windowStartPpq && anchor.ppq < windowStartPpq + windowLengthPpq,
      )
      .map((anchor) => ({
        ppq: anchor.ppq - windowStartPpq,
        sourceSeconds:
          anchor.sourceSeconds +
          (source.warp?.sourceStartSeconds ?? source.sourceOffsetPpq * secondsPerSourcePpq) -
          shiftSeconds,
      })),
    windowLengthPpq,
  );
  return {
    enabled: warp.enabled,
    sourceBpm: warp.sourceBpm,
    ...(sourceStartSeconds !== null && Math.abs(sourceStartSeconds - linearStartSeconds) > 1e-9
      ? { sourceStartSeconds }
      : {}),
    ...(sourceEndSeconds !== null && Math.abs(sourceEndSeconds - linearEndSeconds) > 1e-9
      ? { sourceEndSeconds }
      : {}),
    ...(anchors.length > 0 ? { anchors } : {}),
  };
}

/**
 * Copies app-level metadata that the wasm Project does not derive itself onto
 * a duplicated, split, or trimmed clip mirror. MIDI lane points and cycle-take
 * comp ranges are transformed from the source clip's window into the derived
 * clip's window; cycle-take notes stay source-relative and are clipped to it.
 */
export function withDerivedClipMetadata(
  target: EditorClip,
  source: EditorClip,
  options: DerivedClipMetadataOptions = {},
): EditorClip {
  const windowStartPpq = options.windowStartPpq ?? 0;
  const windowLengthPpq = options.windowLengthPpq ?? target.lengthPpq;
  const next = withAudioMetadata(target, source);
  if (source.takes !== undefined && source.takes.length > 0) {
    next.takes = source.takes.map((take) => ({ ...take }));
    const compSegments = transformCompSegments(source, windowStartPpq, windowLengthPpq);
    if (compSegments !== undefined && compSegments.length > 0) {
      next.compSegments = compSegments;
      next.assetId = next.takes[compSegments[0].takeIndex]?.assetId ?? next.assetId;
    } else {
      delete next.compSegments;
    }
  } else {
    delete next.takes;
    delete next.compSegments;
  }
  if (source.midiTakes !== undefined && source.midiTakes.length > 0) {
    const sourceWindowStartPpq = source.sourceOffsetPpq + windowStartPpq;
    const sourceWindowEndPpq = sourceWindowStartPpq + windowLengthPpq;
    next.midiTakes = source.midiTakes.map((take) =>
      transformMidiTake(
        take,
        sourceWindowStartPpq,
        sourceWindowEndPpq,
        windowStartPpq,
        windowLengthPpq,
      ),
    );
    const activeTakeIndex = clampedTakeIndex(source.midiActiveTakeIndex, source.midiTakes.length);
    next.midiActiveTakeIndex = activeTakeIndex;
    if (source.midiCompSegments !== undefined && source.midiCompSegments.length > 0) {
      const midiCompSegments = transformTakeCompSegments(
        source.midiCompSegments,
        source.midiTakes.length,
        activeTakeIndex,
        source.lengthPpq,
        windowStartPpq,
        windowLengthPpq,
      );
      if (midiCompSegments.length > 0) next.midiCompSegments = midiCompSegments;
      else delete next.midiCompSegments;
    } else {
      delete next.midiCompSegments;
    }
  } else {
    delete next.midiTakes;
    delete next.midiActiveTakeIndex;
    delete next.midiCompSegments;
  }
  const warp = transformWarp(source, target, windowStartPpq, windowLengthPpq);
  if (warp !== undefined) next.warp = warp;
  else delete next.warp;

  const ccLanes = cloneCcLanes(source.ccLanes)
    ?.map((lane) => ({
      controller: lane.controller,
      channel: lane.channel,
      points: transformLanePoints(lane.points, windowStartPpq, windowLengthPpq),
    }))
    .filter((lane) => lane.points.length > 0);
  if (ccLanes !== undefined && ccLanes.length > 0) next.ccLanes = ccLanes;
  else delete next.ccLanes;

  const pitchBendLanes = source.pitchBendLanes
    ?.map<ClipPitchBendLane>((lane) => ({
      channel: lane.channel,
      points: transformLanePoints(lane.points, windowStartPpq, windowLengthPpq),
    }))
    .filter((lane) => lane.points.length > 0);
  if (pitchBendLanes !== undefined && pitchBendLanes.length > 0) {
    next.pitchBendLanes = pitchBendLanes;
  } else {
    delete next.pitchBendLanes;
  }

  const programChangeLanes = source.programChangeLanes
    ?.map<ClipProgramChangeLane>((lane) => ({
      channel: lane.channel,
      points: transformLanePoints(lane.points, windowStartPpq, windowLengthPpq),
    }))
    .filter((lane) => lane.points.length > 0);
  if (programChangeLanes !== undefined && programChangeLanes.length > 0) {
    next.programChangeLanes = programChangeLanes;
  } else {
    delete next.programChangeLanes;
  }

  const channelPressureLanes = source.channelPressureLanes
    ?.map<ClipChannelPressureLane>((lane) => ({
      channel: lane.channel,
      points: transformLanePoints<ClipPressurePoint>(lane.points, windowStartPpq, windowLengthPpq),
    }))
    .filter((lane) => lane.points.length > 0);
  if (channelPressureLanes !== undefined && channelPressureLanes.length > 0) {
    next.channelPressureLanes = channelPressureLanes;
  } else {
    delete next.channelPressureLanes;
  }

  const polyPressureLanes = source.polyPressureLanes
    ?.map<ClipPolyPressureLane>((lane) => ({
      channel: lane.channel,
      pitch: lane.pitch,
      points: transformLanePoints<ClipPressurePoint>(lane.points, windowStartPpq, windowLengthPpq),
    }))
    .filter((lane) => lane.points.length > 0);
  if (polyPressureLanes !== undefined && polyPressureLanes.length > 0) {
    next.polyPressureLanes = polyPressureLanes;
  } else {
    delete next.polyPressureLanes;
  }
  const windowEndPpq = windowStartPpq + windowLengthPpq;
  const smfSysEx = source.smfSysEx
    ?.filter(
      (packet) =>
        Number.isFinite(packet.ppq) && packet.ppq >= windowStartPpq && packet.ppq < windowEndPpq,
    )
    .map<SmfSysExPacket>((packet) => ({
      ...packet,
      ppq: packet.ppq - windowStartPpq,
      data: [...packet.data],
    }));
  if (smfSysEx !== undefined && smfSysEx.length > 0) next.smfSysEx = smfSysEx;
  else delete next.smfSysEx;
  return next;
}
