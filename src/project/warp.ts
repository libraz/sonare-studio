/**
 * Tempo-following (warp) for audio clips: a clip's source audio follows the
 * project tempo, optionally shaped by user warp anchors (clip-relative beats
 * mapped to source seconds). The engine time-stretches warped clips in
 * realtime from a source slice and sample-domain anchors, so live playback
 * and export hand it the same {@link WarpedClipSource}; offline consumers that
 * need PCM render it through the same engine mode.
 */

import type { Project, ProjectWarpMapDesc } from '@libraz/libsonare';
import { clamp01 } from '@/lib/math';
import { ensureWasm } from '@/lib/wasm';
import { nativeClipWarps, readNativeDocument } from './native-document';
import { type NormalizedTempoMap, ppqToSamples } from './tempo-map';
import type { ClipWarp, WarpAnchor } from './types';

/** One stretch segment of a warped clip. */
export interface WarpSegment {
  /** Segment start relative to the clip window, in PPQ. */
  ppq: number;
  /** Segment length in PPQ (> 0). */
  lengthPpq: number;
  /** Segment start in the source, in seconds. */
  sourceStartSeconds: number;
  /** Segment length in the source, in seconds (> 0). */
  sourceLengthSeconds: number;
}

/** The clip fields a warped window reads. */
export interface WarpableClipFields {
  id?: number;
  startPpq?: number;
  lengthPpq: number;
  sourceOffsetPpq: number;
  warp?: ClipWarp;
}

/** Tempo source a warped clip window follows. */
export type WarpTempo = number | NormalizedTempoMap;

/** Fields needed to mirror a clip warp into libsonare's first-class warp API. */
export interface ProjectWarpMapClipFields extends WarpableClipFields {
  id: number;
}

/**
 * Normalizes warp anchors: finite values, strictly inside the clip window,
 * sorted by beat position with strictly increasing source times. Invalid
 * entries drop out.
 */
export function sanitizeWarpAnchors(
  anchors: ReadonlyArray<WarpAnchor>,
  lengthPpq: number,
): WarpAnchor[] {
  const valid = anchors
    .filter(
      (anchor) =>
        Number.isFinite(anchor.ppq) &&
        anchor.ppq > 0 &&
        anchor.ppq < lengthPpq &&
        Number.isFinite(anchor.sourceSeconds) &&
        anchor.sourceSeconds > 0,
    )
    .map((anchor) => ({ ppq: anchor.ppq, sourceSeconds: anchor.sourceSeconds }));
  valid.sort((a, b) => a.ppq - b.ppq);
  const result: WarpAnchor[] = [];
  for (const anchor of valid) {
    const previous = result[result.length - 1];
    if (
      previous &&
      (anchor.ppq <= previous.ppq || anchor.sourceSeconds <= previous.sourceSeconds)
    ) {
      continue;
    }
    result.push(anchor);
  }
  return result;
}

/** Validates and canonicalizes one clip's persisted warp metadata. */
export function sanitizeClipWarp(warp: ClipWarp, lengthPpq: number): ClipWarp {
  if (typeof warp.enabled !== 'boolean') {
    throw new TypeError('Warp enabled must be a boolean');
  }
  if (!Number.isFinite(warp.sourceBpm) || warp.sourceBpm <= 0) {
    throw new RangeError(`Warp sourceBpm must be finite and > 0, got ${warp.sourceBpm}`);
  }
  const anchors = sanitizeWarpAnchors(warp.anchors ?? [], lengthPpq);
  const defaultStartSeconds = 0;
  const startSeconds =
    warp.sourceStartSeconds !== undefined && Number.isFinite(warp.sourceStartSeconds)
      ? warp.sourceStartSeconds
      : defaultStartSeconds;
  const endSeconds =
    warp.sourceEndSeconds !== undefined && Number.isFinite(warp.sourceEndSeconds)
      ? warp.sourceEndSeconds
      : undefined;
  return {
    enabled: warp.enabled,
    sourceBpm: warp.sourceBpm,
    ...(warp.sourceStartSeconds !== undefined && startSeconds >= 0
      ? { sourceStartSeconds: startSeconds }
      : {}),
    ...(endSeconds !== undefined && endSeconds > startSeconds
      ? { sourceEndSeconds: endSeconds }
      : {}),
    ...(anchors.length > 0 ? { anchors } : {}),
  };
}

/**
 * Converts the editor's clip warp metadata into libsonare's first-class
 * sample-domain warp-map descriptor. The editor keeps explicit anchors as
 * clip-relative PPQ -> seconds relative to the clip's trimmed source start;
 * Project stores them as
 * warped-output samples -> source samples.
 */
export function projectWarpMapDesc(
  clip: ProjectWarpMapClipFields,
  tempo: NormalizedTempoMap,
  sampleRate: number,
): ProjectWarpMapDesc | null {
  const warp = clip.warp;
  if (!warp || !(warp.sourceBpm > 0) || !(clip.lengthPpq > 0) || !(sampleRate > 0)) return null;
  const secondsPerSourcePpq = 60 / warp.sourceBpm;
  const sourceStartSeconds =
    clip.warp?.sourceStartSeconds ?? clip.sourceOffsetPpq * secondsPerSourcePpq;
  const sourceEndSeconds =
    clip.warp?.sourceEndSeconds ?? (clip.sourceOffsetPpq + clip.lengthPpq) * secondsPerSourcePpq;
  const clipStartPpq = clip.startPpq ?? 0;
  const clipStartSample = ppqToSamples(tempo, clipStartPpq, sampleRate);
  const points: WarpAnchor[] = [
    { ppq: 0, sourceSeconds: sourceStartSeconds },
    ...sanitizeWarpAnchors(warp.anchors ?? [], clip.lengthPpq).map((anchor) => ({
      ppq: anchor.ppq,
      sourceSeconds: sourceStartSeconds + anchor.sourceSeconds,
    })),
    {
      ppq: clip.lengthPpq,
      sourceSeconds: sourceEndSeconds,
    },
  ];
  const anchors: WarpAnchorFrames[] = [];
  for (const point of points) {
    const warpSample = Math.max(
      0,
      ppqToSamples(tempo, clipStartPpq + point.ppq, sampleRate) - clipStartSample,
    );
    const sourceSample = Math.max(0, Math.round(point.sourceSeconds * sampleRate));
    const previous = anchors[anchors.length - 1];
    // The engine needs strictly increasing pairs, as warpedClipSource and warpSegments keep them.
    if (previous && (warpSample <= previous.warpSample || sourceSample <= previous.sourceSample)) {
      continue;
    }
    anchors.push({ warpSample, sourceSample });
  }
  if (anchors.length < 2) return null;
  return { id: clip.id, name: `clip-${clip.id}-warp`, anchors };
}

/** Mutation seam used by failure-atomic commands to count each native edit. */
export type ProjectWarpEdit = (mutation: () => void) => void;

const directProjectWarpEdit: ProjectWarpEdit = (mutation) => mutation();

/** Installs/replaces a clip-owned native warp map and binds it to that clip. */
export function installProjectClipWarp(
  project: Project,
  clip: ProjectWarpMapClipFields,
  tempo: NormalizedTempoMap,
  edit: ProjectWarpEdit = directProjectWarpEdit,
): boolean {
  const nativeMap = projectWarpMapDesc(clip, tempo, project.sampleRate);
  if (nativeMap === null) return false;
  edit(() => project.setWarpMap(nativeMap));
  edit(() => project.setClipWarpRef(clip.id, nativeMap.id));
  edit(() => project.setClipWarpMode(clip.id, clip.warp?.enabled ? 'tempoSync' : 'off'));
  return true;
}

function readProjectClipWarpState(
  project: Project,
  clipId: number,
): {
  hasMode: boolean;
  refId: number;
  hasMap: boolean;
} {
  const state = readNativeDocument(project);
  const clip = state.clips?.find((entry) => entry.id === clipId);
  return {
    hasMode: nativeClipWarps(clip),
    refId: clip?.warpRefId ?? 0,
    hasMap: state.warpMaps?.some((map) => map.id === clipId) === true,
  };
}

/** True when any native clip warp field/map still needs clearing. */
export function hasProjectClipWarpState(project: Project, clipId: number): boolean {
  const state = readProjectClipWarpState(project, clipId);
  return state.hasMode || state.refId > 0 || state.hasMap;
}

/** True when the clip owns and references its expected native warp map. */
export function hasInstalledProjectClipWarp(project: Project, clipId: number): boolean {
  const state = readProjectClipWarpState(project, clipId);
  return state.refId === clipId && state.hasMap;
}

/**
 * Clears only the native warp fields that actually exist. This avoids calling
 * libsonare's rejecting removeWarpMap API for a missing map and lets atomic
 * callers roll back the exact number of successful edits.
 */
export function clearProjectClipWarp(
  project: Project,
  clipId: number,
  edit: ProjectWarpEdit = directProjectWarpEdit,
): number {
  const state = readProjectClipWarpState(project, clipId);
  let edits = 0;
  if (state.hasMode) {
    edit(() => project.setClipWarpMode(clipId, 'off'));
    edits++;
  }
  if (state.refId > 0) {
    edit(() => project.setClipWarpRef(clipId, 0));
    edits++;
  }
  if (state.hasMap) {
    edit(() => project.removeWarpMap(clipId));
    edits++;
  }
  return edits;
}

/**
 * Expands a warped clip into its stretch segments. The clip edges form
 * implicit anchors: beat 0 maps to the clip's source offset (interpreted at
 * the source tempo) and the clip end to offset + length at the source tempo;
 * user anchors bend the mapping in between.
 */
export function warpSegments(clip: WarpableClipFields): WarpSegment[] {
  const warp = clip.warp;
  if (!warp?.enabled || !(warp.sourceBpm > 0) || !(clip.lengthPpq > 0)) return [];
  const secondsPerSourcePpq = 60 / warp.sourceBpm;
  const startSeconds = warp.sourceStartSeconds ?? clip.sourceOffsetPpq * secondsPerSourcePpq;
  const endSeconds =
    warp.sourceEndSeconds ?? (clip.sourceOffsetPpq + clip.lengthPpq) * secondsPerSourcePpq;
  const points: WarpAnchor[] = [
    { ppq: 0, sourceSeconds: startSeconds },
    ...sanitizeWarpAnchors(warp.anchors ?? [], clip.lengthPpq).map((anchor) => ({
      ppq: anchor.ppq,
      sourceSeconds: startSeconds + anchor.sourceSeconds,
    })),
    { ppq: clip.lengthPpq, sourceSeconds: endSeconds },
  ];
  const segments: WarpSegment[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const lengthPpq = points[i + 1].ppq - points[i].ppq;
    const sourceLengthSeconds = points[i + 1].sourceSeconds - points[i].sourceSeconds;
    if (lengthPpq <= 0 || sourceLengthSeconds <= 0) continue;
    segments.push({
      ppq: points[i].ppq,
      lengthPpq,
      sourceStartSeconds: points[i].sourceSeconds,
      sourceLengthSeconds,
    });
  }
  return segments;
}

/** Maps one clip-local PPQ position to its source-media time through the warp anchors. */
export function warpSourceSecondsAt(clip: WarpableClipFields, clipLocalPpq: number): number | null {
  const segments = warpSegments(clip);
  if (segments.length === 0) return null;
  const ppq = Math.max(0, Math.min(clip.lengthPpq, clipLocalPpq));
  const segment =
    segments.find(
      (candidate) => ppq >= candidate.ppq && ppq <= candidate.ppq + candidate.lengthPpq + 1e-9,
    ) ?? segments[segments.length - 1];
  const progress = clamp01((ppq - segment.ppq) / segment.lengthPpq);
  return segment.sourceStartSeconds + segment.sourceLengthSeconds * progress;
}

/** Engine warp anchor: an output frame of the clip window and the source frame it plays. */
export interface WarpAnchorFrames {
  warpSample: number;
  sourceSample: number;
}

/**
 * A warped clip window as the engine plays it: the source slice the warp map
 * reads, the number of output frames, and the anchors mapping output frames
 * onto that slice. The engine's time-stretch warp mode synthesizes the output
 * from these, so tempo edits move anchors instead of re-rendering audio.
 */
export interface WarpedClipSource {
  channels: Float32Array[];
  lengthFrames: number;
  anchors: WarpAnchorFrames[];
}

function targetSampleAt(tempo: WarpTempo, ppq: number, sampleRate: number): number {
  return typeof tempo === 'number'
    ? Math.round(ppq * (60 / tempo) * sampleRate)
    : ppqToSamples(tempo, ppq, sampleRate);
}

/**
 * Resolves a warped clip window into the source slice and anchors the engine
 * time-stretches. Null when warp is off or the window or source is empty.
 *
 * @param channels Source asset channels (planar PCM).
 * @param sampleRate Source sample rate in Hz; frames on both axes use it.
 * @param clip Clip window and warp state.
 * @param tempo Project tempo the window follows.
 */
export function warpedClipSource(
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  clip: WarpableClipFields,
  tempo: WarpTempo,
): WarpedClipSource | null {
  const segments = warpSegments(clip);
  const sourceFrames = channels[0]?.length ?? 0;
  if (segments.length === 0 || sourceFrames === 0) return null;
  const clipStartPpq = Number.isFinite(clip.startPpq) ? (clip.startPpq ?? 0) : 0;
  const origin = targetSampleAt(tempo, clipStartPpq, sampleRate);
  const lengthFrames = targetSampleAt(tempo, clipStartPpq + clip.lengthPpq, sampleRate) - origin;
  if (lengthFrames <= 0) return null;
  const last = segments[segments.length - 1];
  const points = [
    ...segments.map((segment) => ({ ppq: segment.ppq, seconds: segment.sourceStartSeconds })),
    { ppq: last.ppq + last.lengthPpq, seconds: last.sourceStartSeconds + last.sourceLengthSeconds },
  ];
  const sliceStart = Math.min(
    sourceFrames,
    Math.max(0, Math.round(points[0].seconds * sampleRate)),
  );
  const sliceEnd = Math.min(
    sourceFrames,
    Math.max(sliceStart, Math.round(points[points.length - 1].seconds * sampleRate)),
  );
  if (sliceEnd <= sliceStart) return null;
  const anchors: WarpAnchorFrames[] = [];
  for (const point of points) {
    const warpSample = Math.min(
      lengthFrames,
      targetSampleAt(tempo, clipStartPpq + point.ppq, sampleRate) - origin,
    );
    const sourceSample =
      Math.min(sliceEnd, Math.max(sliceStart, Math.round(point.seconds * sampleRate))) - sliceStart;
    const previous = anchors[anchors.length - 1];
    // The engine needs strictly increasing pairs; rounding can collapse a short segment.
    if (previous && (warpSample <= previous.warpSample || sourceSample <= previous.sourceSample)) {
      continue;
    }
    anchors.push({ warpSample, sourceSample });
  }
  if (anchors.length < 2) return null;
  return {
    channels: channels.map((channel) => channel.slice(sliceStart, sliceEnd)),
    lengthFrames,
    anchors,
  };
}

/** Renders a warped clip window to PCM (tests inject a stand-in for the engine). */
export type WarpRenderFn = (
  source: WarpedClipSource,
  sampleRate: number,
) => Promise<Float32Array[]>;

/**
 * Renders a warped clip window offline through a throwaway realtime engine in
 * its time-stretch mode, so offline consumers hear exactly what playback and
 * export play. Channels render in pairs because an engine lane is stereo; a
 * mono pair keeps one channel.
 */
export const renderWarpedClipSource: WarpRenderFn = async (source, sampleRate) => {
  const wasm = await ensureWasm();
  const rendered: Float32Array[] = [];
  for (let first = 0; first < source.channels.length; first += 2) {
    const pair = source.channels.slice(first, first + 2).map((channel) => channel.slice());
    const engine = new wasm.RealtimeEngine({ sampleRate, maxBlockSize: 512 });
    try {
      engine.setTrackLanes([{ trackId: 1 }]);
      engine.setClips([
        {
          id: 1,
          trackId: 1,
          startPpq: 0,
          lengthSamples: source.lengthFrames,
          channels: pair,
          warpMode: 'timeStretch',
          warpAnchors: source.anchors,
        },
      ]);
      engine.settleParameters();
      engine.play(0);
      const out = engine.renderOffline({
        channels: [new Float32Array(source.lengthFrames), new Float32Array(source.lengthFrames)],
      });
      rendered.push(...out.slice(0, pair.length));
    } finally {
      engine.destroy();
    }
  }
  return rendered;
};
