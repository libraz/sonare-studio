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
import type { ClipWarp, WarpAnchor } from './types';

/** Maximum cached bakes (whole-clip buffers; ~few MB each). */
const WARP_CACHE_LIMIT = 16;

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
  lengthPpq: number;
  sourceOffsetPpq: number;
  warp?: ClipWarp;
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
  const startSeconds = clip.sourceOffsetPpq * secondsPerSourcePpq;
  const points: WarpAnchor[] = [
    { ppq: 0, sourceSeconds: startSeconds },
    ...sanitizeWarpAnchors(warp.anchors ?? [], clip.lengthPpq).map((anchor) => ({
      ppq: anchor.ppq,
      sourceSeconds: startSeconds + anchor.sourceSeconds,
    })),
    { ppq: clip.lengthPpq, sourceSeconds: startSeconds + clip.lengthPpq * secondsPerSourcePpq },
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

/** Mono one-shot time stretch: output length = input length / rate. */
export type StretchFn = (samples: Float32Array, sampleRate: number, rate: number) => Float32Array;

/** Cache of baked warp renders, keyed by content. */
const bakeCache = new Map<string, Float32Array[]>();

/** Clears the bake cache (tests). */
export function clearWarpBakeCache(): void {
  bakeCache.clear();
}

/** Default stretch seam: the wasm phase-vocoder time stretch. */
async function wasmStretch(): Promise<StretchFn> {
  const wasm = (await ensureWasm()) as unknown as {
    timeStretch: (samples: Float32Array, sampleRate: number, rate: number) => Float32Array;
  };
  return (samples, sampleRate, rate) => wasm.timeStretch(samples, sampleRate, rate);
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
 * @param tempoBpm Project tempo the bake targets.
 * @param options.cacheKey Cache identity (e.g. the asset id); absent = uncached.
 * @param options.stretch Stretch seam override (tests).
 * @returns Planar channels covering exactly the clip window at tempoBpm.
 */
export async function bakeWarpedClip(
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  clip: WarpableClipFields,
  tempoBpm: number,
  options: { cacheKey?: string; stretch?: StretchFn } = {},
): Promise<Float32Array[]> {
  const segments = warpSegments(clip);
  if (segments.length === 0 || channels.length === 0) return [];
  const key =
    options.cacheKey !== undefined
      ? `${options.cacheKey}|${sampleRate}|${tempoBpm}|${clip.lengthPpq}|${clip.sourceOffsetPpq}|${JSON.stringify(clip.warp)}`
      : null;
  if (key) {
    const cached = bakeCache.get(key);
    // Callers bake fades into the returned buffers in place, so a cache hit
    // must hand out copies or the fade ramps would compound across passes.
    if (cached) return cached.map((channel) => channel.slice());
  }
  const stretch = options.stretch ?? (await wasmStretch());
  const secondsPerPpq = 60 / tempoBpm;
  const totalFrames = Math.round(clip.lengthPpq * secondsPerPpq * sampleRate);
  const baked = channels.map(() => new Float32Array(totalFrames));
  for (const segment of segments) {
    const sourceBegin = Math.round(segment.sourceStartSeconds * sampleRate);
    const sourceEnd = Math.min(
      channels[0].length,
      Math.round((segment.sourceStartSeconds + segment.sourceLengthSeconds) * sampleRate),
    );
    if (sourceEnd <= sourceBegin) continue;
    const targetBegin = Math.round(segment.ppq * secondsPerPpq * sampleRate);
    const targetFrames = Math.min(
      totalFrames - targetBegin,
      Math.round(segment.lengthPpq * secondsPerPpq * sampleRate),
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
    if (bakeCache.size >= WARP_CACHE_LIMIT) {
      const oldest = bakeCache.keys().next().value;
      if (oldest !== undefined) bakeCache.delete(oldest);
    }
    bakeCache.set(key, baked);
    return baked.map((channel) => channel.slice());
  }
  return baked;
}
