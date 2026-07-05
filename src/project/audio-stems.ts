/**
 * Audio stem separation: runs libsonare's `hpssWithResidual` over an audio
 * clip's played source window, splitting it into harmonic, percussive and
 * residual stems (each keeping the source channel count). When available, a
 * phase-vocoder seam is used as a length repair for separators that return
 * slightly drifted buffers, and an NN-filter seam can refine each waveform stem
 * only when it returns an equal-length matrix. Matrix NMF (`decompose`) is used
 * conservatively as a same-length bleed gate for HPSS waveforms when it returns
 * usable component activations; it never replaces HPSS with a reconstructed
 * waveform.
 *
 * Like {@link analyzeAudioClipChords} and {@link analyzeAudioClipMelody} the
 * window is cut with the same fixed-tempo slice as playback, so the stems line
 * up exactly under the source clip. Stereo clips are separated as linked
 * mid/side channels before being reconstructed to left/right, avoiding the
 * phase instability that comes from running unrelated L/R mono separations.
 * Other channel layouts fall back to independent mono channels.
 * Side-effect-free and dependency-injected for testing; the asset, track and
 * clip creation lives in command/stems.
 */

import type { LoadedAudioAsset } from '@/persistence/assets';
import { sliceAudioClipWindow } from './scheduling';

/** The three bands `hpssWithResidual` separates a signal into. */
export type StemKind = 'harmonic' | 'percussive' | 'residual';

/** Stem bands in the order they are laid down as tracks. */
export const STEM_KINDS: ReadonlyArray<StemKind> = ['harmonic', 'percussive', 'residual'];

/**
 * The stem separator signature (libsonare `hpssWithResidual`): splits one mono
 * channel into three equal-length bands at the same sample rate.
 */
export type AudioStemSeparator = (
  samples: Float32Array,
  sampleRate?: number,
) => {
  harmonic: Float32Array;
  percussive: Float32Array;
  residual: Float32Array;
  sampleRate: number;
};

/** Optional enhancement/repair seams available in newer libsonare builds. */
export interface AudioStemEnhancers {
  /**
   * Phase-vocoder time-scale modification. Used conservatively to repair
   * separator output length drift back to the source window length.
   */
  phaseVocoder?: (
    samples: Float32Array,
    rate: number,
    sampleRate?: number,
    nFft?: number,
    hopLength?: number,
  ) => Float32Array;
  /** Matrix NMF seam kept for capability plumbing; not applied without inverse reconstruction. */
  decompose?: (
    s: Float32Array,
    nFeatures: number,
    nFrames: number,
    nComponents: number,
    nIter?: number,
    beta?: number,
  ) => unknown;
  decomposeWithInit?: (
    s: Float32Array,
    nFeatures: number,
    nFrames: number,
    nComponents: number,
    nIter?: number,
    beta?: number,
    init?: 'random' | 'nndsvd',
  ) => unknown;
  nnFilter?: (
    s: Float32Array,
    nFeatures: number,
    nFrames: number,
    aggregate?: string,
    k?: number,
    width?: number,
  ) =>
    | Float32Array
    | {
        data?: Float32Array;
        values?: Float32Array;
        rows?: number;
        cols?: number;
        nFeatures?: number;
        nFrames?: number;
      }
    | null
    | undefined;
}

/** Injectable dependencies for {@link separateAudioClipStems}. */
export interface AudioStemsDeps {
  /** Loads an audio asset's PCM (defaults to the OPFS asset store). */
  loadAudioAsset: (assetId: string) => Promise<LoadedAudioAsset>;
  /** The stem separator. */
  separateStems: AudioStemSeparator;
  /** Optional enhancement/repair functions. */
  enhancers?: AudioStemEnhancers;
}

/** One separated stem ready to be stored as an asset and laid down as a clip. */
export interface SeparatedStem {
  /** Which band this is. */
  kind: StemKind;
  /** Planar channels (same channel count and length as the source window). */
  channels: Float32Array[];
  /** Sample rate of the channels, in Hz. */
  sampleRate: number;
}

function fitStemLength(
  samples: Float32Array,
  targetFrames: number,
  sampleRate: number,
  phaseVocoder?: AudioStemEnhancers['phaseVocoder'],
): Float32Array {
  if (samples.length === targetFrames) return samples;
  if (targetFrames <= 0) return new Float32Array(0);
  let repaired = samples;
  if (typeof phaseVocoder === 'function' && samples.length > 0) {
    const rate = samples.length / targetFrames;
    if (Number.isFinite(rate) && rate > 0) {
      repaired = phaseVocoder(samples, rate, sampleRate);
    }
  }
  if (repaired.length === targetFrames) return repaired;
  const out = new Float32Array(targetFrames);
  out.set(repaired.subarray(0, targetFrames));
  return out;
}

function matrixData(
  result: ReturnType<NonNullable<AudioStemEnhancers['nnFilter']>>,
): Float32Array | null {
  if (result instanceof Float32Array) return result;
  if (result && result.data instanceof Float32Array) return result.data;
  if (result && result.values instanceof Float32Array) return result.values;
  return null;
}

function unknownMatrixData(result: unknown, keys: readonly string[]): Float32Array | null {
  if (result instanceof Float32Array) return result;
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (value instanceof Float32Array) return value;
  }
  return null;
}

function roughness(values: Float32Array, offset: number, stride: number, frames: number): number {
  let delta = 0;
  let energy = Math.abs(values[offset] ?? 0);
  for (let index = 1; index < frames; index += 1) {
    const previous = values[offset + (index - 1) * stride] ?? 0;
    const current = values[offset + index * stride] ?? 0;
    delta += Math.abs(current - previous);
    energy += Math.abs(current);
  }
  return delta / Math.max(energy, 1e-6);
}

function smoothMasks(
  first: Float32Array,
  second: Float32Array,
): { harmonic: Float32Array; percussive: Float32Array } {
  const frames = Math.min(first.length, second.length);
  const harmonic = new Float32Array(frames);
  const percussive = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) {
    const a = Math.max(0, first[index]);
    const b = Math.max(0, second[index]);
    const total = a + b;
    harmonic[index] = total > 1e-8 ? a / total : 1;
    percussive[index] = total > 1e-8 ? b / total : 1;
  }
  return { harmonic, percussive };
}

function decomposeMasks(
  samples: Float32Array,
  enhancers?: AudioStemEnhancers,
): { harmonic: Float32Array; percussive: Float32Array } | null {
  const decompose = enhancers?.decomposeWithInit ?? enhancers?.decompose;
  if (typeof decompose !== 'function' || samples.length < 2) return null;
  const magnitude = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    magnitude[index] = Math.abs(samples[index]);
  }
  try {
    const result =
      decompose === enhancers?.decomposeWithInit
        ? enhancers.decomposeWithInit(magnitude, 1, samples.length, 2, 40, 2, 'nndsvd')
        : decompose(magnitude, 1, samples.length, 2, 40, 2);
    const activations = unknownMatrixData(result, ['h', 'H', 'activations', 'components']);
    if (!activations || activations.length !== samples.length * 2) return null;
    const first = new Float32Array(samples.length);
    const second = new Float32Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      first[index] = Math.max(0, activations[index]);
      second[index] = Math.max(0, activations[samples.length + index]);
    }
    const firstRough = roughness(activations, 0, 1, samples.length);
    const secondRough = roughness(activations, samples.length, 1, samples.length);
    return firstRough <= secondRough ? smoothMasks(first, second) : smoothMasks(second, first);
  } catch {
    return null;
  }
}

function refineStemWaveform(
  samples: Float32Array,
  nnFilter?: AudioStemEnhancers['nnFilter'],
): Float32Array {
  if (typeof nnFilter !== 'function' || samples.length === 0) return samples;
  try {
    const refined = matrixData(nnFilter(samples, 1, samples.length, 'mean', 7, 1));
    return refined?.length === samples.length ? refined : samples;
  } catch {
    return samples;
  }
}

function applyDecomposeBleedGate(
  split: Record<StemKind, Float32Array>,
  source: Float32Array,
  enhancers?: AudioStemEnhancers,
): Record<StemKind, Float32Array> {
  const masks = decomposeMasks(source, enhancers);
  if (!masks) return split;
  const strength = 0.35;
  const harmonic = new Float32Array(split.harmonic.length);
  const percussive = new Float32Array(split.percussive.length);
  for (let index = 0; index < harmonic.length; index += 1) {
    const harmonicMask = masks.harmonic[index] ?? 1;
    const percussiveMask = masks.percussive[index] ?? 1;
    const sourceSum = split.harmonic[index] + split.percussive[index];
    let gatedHarmonic = split.harmonic[index] * (1 - strength + strength * harmonicMask);
    let gatedPercussive = split.percussive[index] * (1 - strength + strength * percussiveMask);
    const gatedSum = gatedHarmonic + gatedPercussive;
    const deficit = sourceSum - gatedSum;
    if (deficit > 0) {
      if (harmonicMask >= percussiveMask) gatedHarmonic += deficit;
      else gatedPercussive += deficit;
    }
    harmonic[index] = gatedHarmonic;
    percussive[index] = gatedPercussive;
  }
  return { harmonic, percussive, residual: split.residual };
}

function processStemChannel(
  channel: Float32Array,
  sampleRate: number,
  deps: AudioStemsDeps,
): Record<StemKind, Float32Array> {
  const split = deps.separateStems(channel, sampleRate);
  const fitted = {
    harmonic: refineStemWaveform(
      fitStemLength(split.harmonic, channel.length, sampleRate, deps.enhancers?.phaseVocoder),
      deps.enhancers?.nnFilter,
    ),
    percussive: refineStemWaveform(
      fitStemLength(split.percussive, channel.length, sampleRate, deps.enhancers?.phaseVocoder),
      deps.enhancers?.nnFilter,
    ),
    residual: refineStemWaveform(
      fitStemLength(split.residual, channel.length, sampleRate, deps.enhancers?.phaseVocoder),
      deps.enhancers?.nnFilter,
    ),
  };
  return applyDecomposeBleedGate(fitted, channel, deps.enhancers);
}

function midSideChannels(left: Float32Array, right: Float32Array): [Float32Array, Float32Array] {
  const frames = Math.min(left.length, right.length);
  const mid = new Float32Array(frames);
  const side = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) {
    mid[index] = (left[index] + right[index]) * 0.5;
    side[index] = (left[index] - right[index]) * 0.5;
  }
  return [mid, side];
}

function leftRightFromMidSide(mid: Float32Array, side: Float32Array): [Float32Array, Float32Array] {
  const frames = Math.min(mid.length, side.length);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) {
    left[index] = mid[index] + side[index];
    right[index] = mid[index] - side[index];
  }
  return [left, right];
}

/**
 * Separates an audio clip's played window into harmonic / percussive /
 * residual stems. Returns `[]` when the clip has no asset, the tempo is
 * non-positive, or the source window is empty.
 *
 * @param clip Audio clip to split (needs `assetId`).
 * @param tempoBpm Constant tempo (> 0) used for the playback-matching slice.
 * @param deps Injected asset loader and stem separator.
 * @returns One {@link SeparatedStem} per band (always three when non-empty), in
 *   {@link STEM_KINDS} order.
 */
export async function separateAudioClipStems(
  clip: { assetId?: string; lengthPpq: number; sourceOffsetPpq: number },
  tempoBpm: number,
  deps: AudioStemsDeps,
): Promise<SeparatedStem[]> {
  if (clip.assetId === undefined || !(tempoBpm > 0)) return [];
  const asset = await deps.loadAudioAsset(clip.assetId);
  const sampleRate = asset.meta.sampleRate;
  const window = sliceAudioClipWindow(
    asset.channels,
    sampleRate,
    clip.sourceOffsetPpq,
    clip.lengthPpq,
    tempoBpm,
  );
  if (window.length === 0 || (window[0]?.length ?? 0) === 0) return [];

  const harmonic: Float32Array[] = [];
  const percussive: Float32Array[] = [];
  const residual: Float32Array[] = [];
  if (window.length === 2) {
    const [mid, side] = midSideChannels(window[0], window[1]);
    const midStems = processStemChannel(mid, sampleRate, deps);
    const sideStems = processStemChannel(side, sampleRate, deps);
    for (const kind of STEM_KINDS) {
      const [left, right] = leftRightFromMidSide(midStems[kind], sideStems[kind]);
      if (kind === 'harmonic') harmonic.push(left, right);
      else if (kind === 'percussive') percussive.push(left, right);
      else residual.push(left, right);
    }
  } else {
    for (const channel of window) {
      const split = processStemChannel(channel, sampleRate, deps);
      harmonic.push(split.harmonic);
      percussive.push(split.percussive);
      residual.push(split.residual);
    }
  }
  return [
    { kind: 'harmonic', channels: harmonic, sampleRate },
    { kind: 'percussive', channels: percussive, sampleRate },
    { kind: 'residual', channels: residual, sampleRate },
  ];
}
