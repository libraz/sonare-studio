import { sanitizeCompSegments, takeIndexAtPpq } from '../comping';
import { cloneCcLanes } from '../midi-cc';
import type { useProjectStore } from '../store';
import type {
  ClipChannelPressureLane,
  ClipCompSegment,
  ClipPitchBendLane,
  ClipPolyPressureLane,
  ClipPressurePoint,
  ClipWarp,
  EditorClip,
  EditorTrack,
} from '../types';
import { sanitizeWarpAnchors } from '../warp';

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
  value: number;
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

function transformCompSegments(
  source: EditorClip,
  windowStartPpq: number,
  windowLengthPpq: number,
): ClipCompSegment[] | undefined {
  const takes = source.takes;
  if (takes === undefined || takes.length === 0) return undefined;
  const current = sanitizeCompSegments(
    source.compSegments && source.compSegments.length > 0
      ? source.compSegments
      : [{ startPpq: 0, takeIndex: 0 }],
    takes.length,
    source.lengthPpq,
  );
  const windowEndPpq = windowStartPpq + windowLengthPpq;
  const next = [
    { startPpq: 0, takeIndex: takeIndexAtPpq(current, windowStartPpq) },
    ...current
      .filter((segment) => segment.startPpq > windowStartPpq && segment.startPpq < windowEndPpq)
      .map((segment) => ({
        startPpq: segment.startPpq - windowStartPpq,
        takeIndex: segment.takeIndex,
      })),
  ];
  return sanitizeCompSegments(next, takes.length, windowLengthPpq);
}

function transformWarp(
  warp: ClipWarp | undefined,
  windowStartPpq: number,
  windowLengthPpq: number,
): ClipWarp | undefined {
  if (warp === undefined) return undefined;
  const secondsPerSourcePpq = warp.sourceBpm > 0 ? 60 / warp.sourceBpm : 0;
  const sourceShiftSeconds = windowStartPpq * secondsPerSourcePpq;
  const anchors = sanitizeWarpAnchors(
    (warp.anchors ?? [])
      .filter(
        (anchor) => anchor.ppq > windowStartPpq && anchor.ppq < windowStartPpq + windowLengthPpq,
      )
      .map((anchor) => ({
        ppq: anchor.ppq - windowStartPpq,
        sourceSeconds: anchor.sourceSeconds - sourceShiftSeconds,
      })),
    windowLengthPpq,
  );
  return {
    enabled: warp.enabled,
    sourceBpm: warp.sourceBpm,
    ...(anchors.length > 0 ? { anchors } : {}),
  };
}

/**
 * Copies app-level metadata that the wasm Project does not derive itself onto
 * a duplicated, split, or trimmed clip mirror. MIDI lane points are transformed
 * from the source clip's window into the derived clip's window.
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
  const warp = transformWarp(source.warp, windowStartPpq, windowLengthPpq);
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
  return next;
}
