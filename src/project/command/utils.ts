import { activeTakeIndex, sanitizeCompSegments } from '../comping';
import {
  type AnyMidiLaneKind,
  assignMidiLaneFields,
  transformMidiLaneFields,
} from '../midi-lane-kinds';
import { getAudioSourceId, type useProjectStore } from '../store';
import type {
  ClipCompSegment,
  ClipWarp,
  EditorClip,
  EditorTrack,
  MidiClipTake,
  SmfSysExPacket,
} from '../types';
import { sanitizeWarpAnchors, warpSourceSecondsAt } from '../warp';

/**
 * The Project source already registered for an asset, or undefined when there is none or undo
 * has rolled the registration back (the id then points past the source list).
 */
export function reusableAudioSourceId(assetId: string, sourceCount: number): number | undefined {
  const known = getAudioSourceId(assetId);
  return known !== undefined && known >= 1 && known <= sourceCount ? known : undefined;
}

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
 * Moves a clip clear of its own range so a replacement can be built there.
 *
 * A track carries one lane of clips that may abut but never overlap, and the
 * Project rejects an addClip that breaks that. Replacing a clip by building
 * the new one first — so nothing destructive happens until the replacement is
 * known good — therefore has to make room: the original is parked past the end
 * of everything on its track for the moment the two coexist, and removed from
 * there. Both edits belong to the same atomic transaction, so the park is
 * never observable and is reversed with the rest if a later step fails.
 *
 * @param store Project store holding the clip mirror.
 * @param clip The clip about to be replaced.
 * @param move Applies the move through the caller's transaction.
 */
export function parkClipForReplacement(
  store: ReturnType<typeof useProjectStore>,
  clip: EditorClip,
  move: (startPpq: number) => void,
): void {
  const trackEnd = store.clips.reduce(
    (end, entry) =>
      entry.trackId === clip.trackId ? Math.max(end, entry.startPpq + entry.lengthPpq) : end,
    0,
  );
  // Past every clip on the lane, including the replacement that is about to
  // occupy this clip's own range.
  move(trackEnd + clip.lengthPpq);
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

/**
 * Cuts lane points to the range `[startPpq, endPpq]`, keeping their positions.
 * Each edge inside a segment gets the point the kind places there (the value a
 * ramp has reached, or the held value), so the window plays what the source
 * played over it.
 */
export function windowLanePoints<P extends PpqPoint>(
  kind: AnyMidiLaneKind,
  points: ReadonlyArray<P>,
  startPpq: number,
  endPpq: number,
): P[] {
  const pointAt = kind.pointAt as unknown as (previous: P, next: P | undefined, ppq: number) => P;
  const ramps = kind.ramps as unknown as (point: P) => boolean;
  const sorted = points.filter((point) => Number.isFinite(point.ppq)).sort((a, b) => a.ppq - b.ppq);
  const before = sorted.filter((point) => point.ppq < startPpq).at(-1);
  const inside = sorted.filter((point) => point.ppq >= startPpq && point.ppq <= endPpq);
  const after = sorted.find((point) => point.ppq > endPpq);
  const out = inside.map((point) => ({ ...point }));
  if (before !== undefined && inside[0]?.ppq !== startPpq) {
    out.unshift(pointAt(before, inside[0] ?? after, startPpq));
  }
  const last = out.at(-1);
  if (last !== undefined && after !== undefined && last.ppq < endPpq && ramps(last)) {
    out.push(pointAt(inside.at(-1) ?? (before as P), after, endPpq));
  }
  return out;
}

/** Lane points of the window starting at `windowStartPpq`, rebased to it. */
function transformLanePoints<P extends PpqPoint>(
  kind: AnyMidiLaneKind,
  points: ReadonlyArray<P>,
  windowStartPpq: number,
  windowLengthPpq: number,
): P[] {
  const length = Number.isFinite(windowLengthPpq) && windowLengthPpq > 0 ? windowLengthPpq : 0;
  return windowLanePoints(kind, points, windowStartPpq, windowStartPpq + length).map((point) => ({
    ...point,
    ppq: point.ppq - windowStartPpq,
  }));
}

/**
 * Clips notes to the source range `[sourceWindowStartPpq, sourceWindowEndPpq)`,
 * keeping the source-relative frame: a note crossing an edge is cut there
 * rather than dropped. The native Project uses this frame for clip notes after
 * a split/trim, so rebasing would make a derived take play at the wrong offset.
 */
export function windowMidiNotes(
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
    notes: windowMidiNotes(take.notes, sourceWindowStartPpq, sourceWindowEndPpq),
  };
  Object.assign(
    next,
    transformMidiLaneFields(take, (points, kind) =>
      transformLanePoints(kind, points, windowStartPpq, windowLengthPpq),
    ),
  );
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
    const activeIndex = activeTakeIndex(source.midiActiveTakeIndex, source.midiTakes.length);
    next.midiActiveTakeIndex = activeIndex;
    if (source.midiCompSegments !== undefined && source.midiCompSegments.length > 0) {
      const midiCompSegments = transformTakeCompSegments(
        source.midiCompSegments,
        source.midiTakes.length,
        activeIndex,
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

  assignMidiLaneFields(
    next,
    transformMidiLaneFields(source, (points, kind) =>
      transformLanePoints(kind, points, windowStartPpq, windowLengthPpq),
    ),
  );
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
