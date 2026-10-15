/**
 * Aligns an audio clip's timing to a reference clip: libsonare's
 * `alignTakeToReference` matches the two by chroma and returns sample anchors
 * (reference timeline -> take source), which become the clip's warp anchors,
 * so the engine time-stretches the take under the reference.
 *
 * The take is read from the clip's own source start, the reference is the
 * reference clip's audible content over the clip's window, and the anchors are
 * thinned to the bends that matter before they reach the warp map. Pure and
 * dependency-injected; the command wires the wasm call and the undoable edit.
 */

import { downmixToMono } from '@/lib/audio-channels';
import type { LoadedAudioAsset } from '@/persistence/assets';
import type { AlignTakeToReferenceRequest, AlignTakeToReferenceResult } from '@/wasm/index.js';
import {
  type AudibleAudioClipFields,
  audioClipWindowFrames,
  renderAudibleAudioClipWindow,
} from './scheduling';
import { type NormalizedTempoMap, ppqToSeconds, secondsToPpq } from './tempo-map';
import type { ClipWarp, WarpAnchor } from './types';
import { type WarpRenderFn, warpSegments } from './warp';

/**
 * Chroma hop the alignment measures at (the engine default). A dropped anchor
 * may drift up to one hop, the resolution the path is measured at.
 */
const ALIGN_HOP_FRAMES = 512;

/** Share of the clip length the take may run past its window when it is slower. */
const TAKE_OVERRUN = 0.5;

/** Why a clip cannot be aligned to a reference. */
export type TakeAlignmentRefusal = 'reference-short' | 'take-empty';

/** Injectable dependencies for {@link alignClipWarp}. */
export interface TakeAlignmentDeps {
  loadAudioAsset: (assetId: string) => Promise<LoadedAudioAsset>;
  align: (request: AlignTakeToReferenceRequest) => AlignTakeToReferenceResult;
  renderWarp?: WarpRenderFn;
}

/** The clip fields alignment reads. */
export type AlignableClip = AudibleAudioClipFields & { assetId?: string; warp?: ClipWarp };

/** A computed alignment: the warp to store and how far the path strayed. */
export interface ClipAlignment {
  warp: ClipWarp;
  meanResidualFrames: number;
}

interface FrameAnchor {
  warpSample: number;
  sourceSample: number;
}

/**
 * Keeps the anchors a straight line between neighbours cannot stand in for
 * (Ramer-Douglas-Peucker on the source axis).
 */
export function thinAnchors(anchors: ReadonlyArray<FrameAnchor>, tolerance: number): FrameAnchor[] {
  if (anchors.length <= 2) return [...anchors];
  const keep = new Array<boolean>(anchors.length).fill(false);
  keep[0] = true;
  keep[anchors.length - 1] = true;
  const stack: Array<[number, number]> = [[0, anchors.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    const a = anchors[first];
    const b = anchors[last];
    const slope = (b.sourceSample - a.sourceSample) / (b.warpSample - a.warpSample);
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = first + 1; i < last; i++) {
      const expected = a.sourceSample + (anchors[i].warpSample - a.warpSample) * slope;
      const distance = Math.abs(anchors[i].sourceSample - expected);
      if (distance > worstDistance) {
        worst = i;
        worstDistance = distance;
      }
    }
    if (worst < 0) continue;
    keep[worst] = true;
    stack.push([first, worst], [worst, last]);
  }
  return anchors.filter((_, index) => keep[index]);
}

/**
 * Computes the warp that places a clip's take under a reference clip, or a
 * refusal when the reference does not cover the clip's window or the take has
 * no audio there.
 */
export async function alignClipWarp(
  clip: AlignableClip,
  reference: AudibleAudioClipFields,
  tempo: NormalizedTempoMap,
  deps: TakeAlignmentDeps,
): Promise<ClipAlignment | TakeAlignmentRefusal> {
  if (!clip.assetId) return 'take-empty';
  const asset = await deps.loadAudioAsset(clip.assetId);
  const sampleRate = asset.meta.sampleRate;
  const clipStartSeconds = ppqToSeconds(tempo, clip.startPpq);
  const windowSeconds = ppqToSeconds(tempo, clip.startPpq + clip.lengthPpq) - clipStartSeconds;
  const takeWindowFrames = Math.round(windowSeconds * sampleRate);

  const warpedStart = warpSegments(clip)[0]?.sourceStartSeconds;
  const takeStart =
    warpedStart !== undefined
      ? Math.round(warpedStart * sampleRate)
      : audioClipWindowFrames(
          asset.channels[0]?.length ?? 0,
          sampleRate,
          clip.sourceOffsetPpq,
          clip.lengthPpq,
          tempo,
          clip.startPpq - clip.sourceOffsetPpq,
        ).start;
  const takeEnd = Math.min(
    asset.channels[0]?.length ?? 0,
    takeStart + Math.round(takeWindowFrames * (1 + TAKE_OVERRUN)),
  );
  if (takeEnd - takeStart <= 0) return 'take-empty';
  const take = downmixToMono(
    asset.channels.map((channel) => channel.subarray(takeStart, takeEnd)),
    { copy: true },
  );

  const rendered = await renderAudibleAudioClipWindow(reference, tempo, deps.loadAudioAsset, {
    renderWarp: deps.renderWarp,
  });
  if (!rendered) return 'reference-short';
  // The reference stays at its rendered rate; the anchors come back in samples at that rate.
  const referenceRate = rendered.sampleRate;
  const windowFrames = Math.round(windowSeconds * referenceRate);
  const offset = Math.round(
    (clipStartSeconds - ppqToSeconds(tempo, reference.startPpq)) * referenceRate,
  );
  const referenceMono = downmixToMono(rendered.channels);
  if (offset < 0 || offset + windowFrames > referenceMono.length) return 'reference-short';
  const referenceWindow = referenceMono.subarray(offset, offset + windowFrames);

  const result = deps.align({
    reference: referenceWindow,
    take,
    sampleRate: referenceRate,
    takeSampleRate: sampleRate,
    hopLength: ALIGN_HOP_FRAMES,
  });
  const anchors = thinAnchors(result.anchors, ALIGN_HOP_FRAMES);
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  const previous = anchors[anchors.length - 2] ?? first;
  // The path can stop short of the window end; carry on at its last rate.
  const tailRate =
    last.warpSample > previous.warpSample
      ? (last.sourceSample - previous.sourceSample) / (last.warpSample - previous.warpSample)
      : 1;
  const endSource = last.sourceSample + Math.max(0, windowFrames - last.warpSample) * tailRate;
  const sourceStartSeconds = takeStart / sampleRate + first.sourceSample / referenceRate;
  const interior: WarpAnchor[] = anchors.slice(1).flatMap((anchor) => {
    const ppq =
      secondsToPpq(tempo, clipStartSeconds + anchor.warpSample / referenceRate) - clip.startPpq;
    return ppq > 0 && ppq < clip.lengthPpq
      ? [{ ppq, sourceSeconds: (anchor.sourceSample - first.sourceSample) / referenceRate }]
      : [];
  });
  return {
    warp: {
      enabled: true,
      sourceBpm: clip.warp?.sourceBpm ?? 60 / (windowSeconds / clip.lengthPpq),
      sourceStartSeconds,
      sourceEndSeconds: takeStart / sampleRate + endSource / referenceRate,
      ...(interior.length > 0 ? { anchors: interior } : {}),
    },
    meanResidualFrames: result.alignment.meanResidualFrames,
  };
}
