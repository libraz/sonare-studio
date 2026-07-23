/**
 * Tempo-following (warp) bake for audio clips: stretches a clip's source
 * audio offline so its beat positions land on the current project tempo,
 * optionally shaped by user warp anchors (clip-relative beats mapped to
 * source seconds). The engine has no realtime time-stretch, so warped clips
 * are baked here and scheduled as plain audio — live playback and the
 * offline export renderer share this module, keeping both identical.
 *
 * Baked buffers are cached by content key; tempo edits re-bake on the next
 * schedule pass (the apply watcher keys include the warp state).
 */

import { ensureWasm } from '@/lib/wasm';
import type { Project, ProjectWarpMapDesc } from '@/wasm/index.js';
import { type NormalizedTempoMap, ppqToSamples } from './tempo-map';
import type { ClipWarp, WarpAnchor } from './types';

/** Maximum cached bakes (whole-clip buffers; ~few MB each). */
const WARP_CACHE_LIMIT = 16;

/** Default retained PCM budget for warped clip bakes (64 MiB). */
export const DEFAULT_WARP_CACHE_BYTE_BUDGET = 64 * 1024 * 1024;

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

/** The clip fields the warp bake reads. */
export interface WarpableClipFields {
  id?: number;
  startPpq?: number;
  lengthPpq: number;
  sourceOffsetPpq: number;
  warp?: ClipWarp;
}

/** Tempo source used when baking warped clip target frames. */
export type WarpBakeTempo = number | NormalizedTempoMap;

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
  const anchors = points.map((anchor) => ({
    warpSample: Math.max(
      0,
      ppqToSamples(tempo, clipStartPpq + anchor.ppq, sampleRate) - clipStartSample,
    ),
    sourceSample: Math.max(0, Math.round(anchor.sourceSeconds * sampleRate)),
  }));
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
  const nativeMap = projectWarpMapDesc(clip, tempo, project.getSampleRate());
  if (nativeMap === null) return false;
  edit(() => project.setWarpMap(nativeMap));
  edit(() => project.setClipWarpRef(clip.id, nativeMap.id));
  edit(() => project.setClipWarpMode(clip.id, clip.warp?.enabled ? 'tempo-sync' : 'off'));
  return true;
}

interface SerializedNativeWarpState {
  clips?: Array<{ id?: number; warp_ref_id?: number; warp_mode?: number }>;
  warp_maps?: Array<{ id?: number }>;
}

function readProjectClipWarpState(
  project: Project,
  clipId: number,
): {
  hasMode: boolean;
  refId: number;
  hasMap: boolean;
} {
  const state = JSON.parse(project.toJson()) as SerializedNativeWarpState;
  const clip = state.clips?.find((entry) => entry.id === clipId);
  return {
    hasMode: (clip?.warp_mode ?? 0) !== 0,
    refId: clip?.warp_ref_id ?? 0,
    hasMap: state.warp_maps?.some((map) => map.id === clipId) === true,
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
  const progress = Math.max(0, Math.min(1, (ppq - segment.ppq) / segment.lengthPpq));
  return segment.sourceStartSeconds + segment.sourceLengthSeconds * progress;
}

/** Mono one-shot time stretch: output length = input length / rate. */
export type StretchFn = (samples: Float32Array, sampleRate: number, rate: number) => Float32Array;

/** Cache of baked warp renders, keyed by content. */
const bakeCache = new Map<string, Float32Array[]>();
let bakeCacheByteBudget = DEFAULT_WARP_CACHE_BYTE_BUDGET;
let bakeCacheBytes = 0;

function bakedBytes(channels: ReadonlyArray<Float32Array>): number {
  return channels.reduce((sum, channel) => sum + channel.byteLength, 0);
}

function removeBake(key: string): void {
  const cached = bakeCache.get(key);
  if (!cached) return;
  bakeCache.delete(key);
  bakeCacheBytes -= bakedBytes(cached);
}

/** Current warp-bake LRU usage for diagnostics and memory tests. */
export function warpBakeCacheStats(): {
  entries: number;
  bytes: number;
  budgetBytes: number;
  /** Least-recently-used to most-recently-used content keys. */
  keys: string[];
} {
  return {
    entries: bakeCache.size,
    bytes: bakeCacheBytes,
    budgetBytes: bakeCacheByteBudget,
    keys: [...bakeCache.keys()],
  };
}

/** Sets the warp-bake byte budget and evicts least-recently-used entries. */
export function configureWarpBakeCacheByteBudget(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError(`Warp cache byte budget must be finite and >= 0, got ${bytes}`);
  }
  bakeCacheByteBudget = Math.floor(bytes);
  while (bakeCacheBytes > bakeCacheByteBudget && bakeCache.size > 0) {
    const oldest = bakeCache.keys().next().value;
    if (oldest === undefined) break;
    removeBake(oldest);
  }
}

/** Clears the bake cache (tests). */
export function clearWarpBakeCache(): void {
  bakeCache.clear();
  bakeCacheBytes = 0;
}

/** Default stretch seam: prefer transient-preserving noteStretch, then timeStretch. */
async function wasmStretch(): Promise<StretchFn> {
  const wasm = (await ensureWasm()) as unknown as {
    noteStretch?: (
      samples: Float32Array,
      sampleRate?: number,
      options?: { onsetSample?: number; offsetSample?: number; stretchRatio?: number },
    ) => Float32Array;
    timeStretch: (samples: Float32Array, sampleRate: number, rate: number) => Float32Array;
  };
  if (typeof wasm.noteStretch === 'function') {
    return (samples, sampleRate, rate) =>
      wasm.noteStretch?.(samples, sampleRate, {
        onsetSample: 0,
        offsetSample: samples.length,
        stretchRatio: rate,
      }) ?? wasm.timeStretch(samples, sampleRate, rate);
  }
  return (samples, sampleRate, rate) => wasm.timeStretch(samples, sampleRate, rate);
}

function targetSampleAt(tempo: WarpBakeTempo, ppq: number, sampleRate: number): number {
  return typeof tempo === 'number'
    ? Math.round(ppq * (60 / tempo) * sampleRate)
    : ppqToSamples(tempo, ppq, sampleRate);
}

function tempoCacheKey(tempo: WarpBakeTempo): string {
  return typeof tempo === 'number' ? String(tempo) : JSON.stringify(tempo.segments);
}

/**
 * Bakes a warped clip's audible window at the given tempo: every stretch
 * segment of the source is time-stretched so its beats land on the project
 * grid, and the segments concatenate into one buffer of exactly the clip
 * window's length. Results are cached by content key.
 *
 * @param channels Source asset channels (planar PCM).
 * @param sampleRate Source (and output) sample rate in Hz.
 * @param clip Clip window and warp state.
 * @param tempo Project tempo the bake targets.
 * @param options.cacheKey Cache identity (e.g. the asset id); absent = uncached.
 * @param options.stretch Stretch seam override (tests).
 * @returns Planar channels covering exactly the clip window at the target tempo.
 */
export async function bakeWarpedClip(
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  clip: WarpableClipFields,
  tempo: WarpBakeTempo,
  options: { cacheKey?: string; stretch?: StretchFn } = {},
): Promise<Float32Array[]> {
  const segments = warpSegments(clip);
  if (segments.length === 0 || channels.length === 0) return [];
  const clipStartPpq = Number.isFinite(clip.startPpq) ? (clip.startPpq ?? 0) : 0;
  const targetOrigin = targetSampleAt(tempo, clipStartPpq, sampleRate);
  const totalFrames = Math.max(
    0,
    targetSampleAt(tempo, clipStartPpq + clip.lengthPpq, sampleRate) - targetOrigin,
  );
  if (totalFrames === 0) return [];
  const key =
    options.cacheKey !== undefined
      ? `${options.cacheKey}|${sampleRate}|${tempoCacheKey(tempo)}|${clipStartPpq}|${clip.lengthPpq}|${clip.sourceOffsetPpq}|${JSON.stringify(clip.warp)}`
      : null;
  if (key) {
    const cached = bakeCache.get(key);
    // Callers bake fades into the returned buffers in place, so a cache hit
    // must hand out copies or the fade ramps would compound across passes.
    if (cached) {
      bakeCache.delete(key);
      bakeCache.set(key, cached);
      return cached.map((channel) => channel.slice());
    }
  }
  const stretch = options.stretch ?? (await wasmStretch());
  const baked = channels.map(() => new Float32Array(totalFrames));
  for (const segment of segments) {
    const sourceBegin = Math.round(segment.sourceStartSeconds * sampleRate);
    const sourceEnd = Math.min(
      channels[0].length,
      Math.round((segment.sourceStartSeconds + segment.sourceLengthSeconds) * sampleRate),
    );
    if (sourceEnd <= sourceBegin) continue;
    const targetBegin =
      targetSampleAt(tempo, clipStartPpq + segment.ppq, sampleRate) - targetOrigin;
    const targetFrames = Math.min(
      totalFrames - targetBegin,
      targetSampleAt(tempo, clipStartPpq + segment.ppq + segment.lengthPpq, sampleRate) -
        targetOrigin -
        targetBegin,
    );
    if (targetFrames <= 0) continue;
    const rate = (sourceEnd - sourceBegin) / targetFrames;
    for (let ch = 0; ch < channels.length; ch++) {
      const slice = channels[ch].subarray(sourceBegin, sourceEnd);
      const stretched =
        Math.abs(rate - 1) < 1e-6 ? slice : stretch(new Float32Array(slice), sampleRate, rate);
      const frames = Math.min(targetFrames, stretched.length);
      baked[ch].set(stretched.subarray(0, frames), targetBegin);
    }
  }
  if (key) {
    const bytes = bakedBytes(baked);
    while (
      bakeCache.size > 0 &&
      (bakeCache.size >= WARP_CACHE_LIMIT || bakeCacheBytes + bytes > bakeCacheByteBudget)
    ) {
      const oldest = bakeCache.keys().next().value;
      if (oldest === undefined) break;
      removeBake(oldest);
    }
    if (bytes <= bakeCacheByteBudget) {
      bakeCache.set(key, baked);
      bakeCacheBytes += bytes;
    }
    return baked.map((channel) => channel.slice());
  }
  return baked;
}
