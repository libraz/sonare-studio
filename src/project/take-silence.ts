/**
 * Common silence across a comped clip's takes: the spans where every take is
 * quiet at once, which is where a comp boundary can switch takes without
 * cutting any of them mid-phrase.
 *
 * Each take is read through the clip's window exactly as playback slices it,
 * so the spans line up with what the comp plays. A looped clip is skipped (its
 * repeats are the same window), as is a clip whose takes do not share one
 * sample rate, because frame indices from two rates do not describe the same
 * positions. Side-effect-free and dependency-injected.
 */

import { downmixToMono } from '@/lib/audio-channels';
import { maxOf } from '@/lib/math';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { sliceAudioClipWindow } from './audio-clip-render';
import { type NormalizedTempoMap, ppqToSeconds, secondsToPpq } from './tempo-map';
import type { ClipTake } from './types';

/** Shortest common silence worth offering as a cut point, in seconds. */
const MIN_COMMON_SILENCE_SECONDS = 0.05;

/** A clip-relative PPQ span. */
export interface PpqSpan {
  startPpq: number;
  endPpq: number;
}

/** The clip fields the common-silence scan reads. */
export interface TakeSilenceClip {
  startPpq: number;
  lengthPpq: number;
  sourceOffsetPpq: number;
  loopEnabled?: boolean;
  takes?: ReadonlyArray<ClipTake>;
}

/** Injectable dependencies for {@link commonTakeSilence}. */
export interface TakeSilenceDeps {
  loadAudioAsset: (assetId: string) => Promise<LoadedAudioAsset>;
  /** Non-silent intervals the signals share, as flat sample pairs. */
  splitSilenceCommon: (signals: Float32Array[]) => Int32Array;
}

/**
 * Clip-relative PPQ spans where every take is silent at once, shortest first
 * dropped. Empty for a clip with fewer than two takes.
 */
export async function commonTakeSilence(
  clip: TakeSilenceClip,
  tempo: NormalizedTempoMap,
  deps: TakeSilenceDeps,
): Promise<PpqSpan[]> {
  const takes = clip.takes ?? [];
  if (takes.length < 2 || clip.loopEnabled) return [];
  const assets = await Promise.all(takes.map((take) => deps.loadAudioAsset(take.assetId)));
  const sampleRate = assets[0].meta.sampleRate;
  if (assets.some((asset) => asset.meta.sampleRate !== sampleRate)) return [];

  const originPpq = clip.startPpq - clip.sourceOffsetPpq;
  const signals = assets.map((asset) =>
    downmixToMono(
      sliceAudioClipWindow(
        asset.channels,
        sampleRate,
        clip.sourceOffsetPpq,
        clip.lengthPpq,
        tempo,
        originPpq,
      ),
    ),
  );
  const frames = maxOf(signals.map((signal) => signal.length));
  if (frames === 0) return [];
  const sounding = deps.splitSilenceCommon(signals);

  const clipStartSec = ppqToSeconds(tempo, clip.startPpq);
  const toClipPpq = (frame: number): number =>
    secondsToPpq(tempo, clipStartSec + frame / sampleRate) - clip.startPpq;
  const minFrames = MIN_COMMON_SILENCE_SECONDS * sampleRate;
  const spans: PpqSpan[] = [];
  let cursor = 0;
  const addGap = (end: number): void => {
    if (end - cursor >= minFrames) {
      spans.push({ startPpq: toClipPpq(cursor), endPpq: toClipPpq(end) });
    }
  };
  for (let i = 0; i + 1 < sounding.length; i += 2) {
    addGap(sounding[i]);
    cursor = Math.max(cursor, sounding[i + 1]);
  }
  addGap(frames);
  return spans;
}

/**
 * Snaps a clip-relative position that falls inside a common silence to that
 * silence's centre, the cut point furthest from both phrases; other positions
 * are returned unchanged.
 */
export function snapToCommonSilence(spans: ReadonlyArray<PpqSpan>, ppq: number): number {
  const span = spans.find((entry) => ppq >= entry.startPpq && ppq <= entry.endPpq);
  return span ? (span.startPpq + span.endPpq) / 2 : ppq;
}
