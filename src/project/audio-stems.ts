/**
 * Audio stem separation: runs libsonare's `hpssWithResidual` over an audio
 * clip's played source window, splitting it into harmonic, percussive and
 * residual stems (each keeping the source channel count). When available, a
 * phase-vocoder seam is used as a length repair for separators that return
 * slightly drifted buffers, and an NN-filter seam can refine each waveform stem
 * only when it returns an equal-length matrix.
 *
 * `separateAudioClipComponents` splits the same rendered window into an
 * arbitrary number of NMF components through an injected async `decompose`
 * (production calls `decomposeStemsLinked` off the main thread; see
 * decompose-stems-client).
 *
 * Both separators render their input through the same audible clip pipeline as
 * live playback and export, so take/comp, loop, warp, fades and tempo-map
 * changes are already baked into the clip-local window. For HPSS, stereo clips
 * are separated as linked mid/side channels before being reconstructed to
 * left/right, avoiding the phase instability that comes from running unrelated
 * L/R mono separations; other channel layouts fall back to independent mono
 * channels. Component separation instead hands every channel to one shared NMF
 * model, so the stereo image and per-channel phase are the wasm seam's own to
 * preserve.
 * Side-effect-free and dependency-injected for testing; the asset, track and
 * clip creation lives in command/stems.
 */

import type { LoadedAudioAsset } from '@/persistence/assets';
import {
  type AudibleAudioClipFields,
  type AudioClipSliceTempo,
  renderAudibleAudioClipWindow,
} from './scheduling';
import type { StretchFn } from './warp';

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
    sampleRate: number,
    rate: number,
    nFft?: number,
    hopLength?: number,
  ) => Float32Array;
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
  /** Warp stretch seam override (tests); production shares the playback wasm seam. */
  stretch?: StretchFn;
}

/** One separated stem ready to be stored as an asset and laid down as a clip. */
export interface SeparatedStem {
  /** Which band this is, or `'component'` for an NMF component. */
  kind: StemKind | 'component';
  /** 0-based component index; set only when `kind` is `'component'`. */
  index?: number;
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
      repaired = phaseVocoder(samples, sampleRate, rate);
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

function processStemChannel(
  channel: Float32Array,
  sampleRate: number,
  deps: AudioStemsDeps,
): Record<StemKind, Float32Array> {
  const split = deps.separateStems(channel, sampleRate);
  return {
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

/** Renders an audio clip's played window, or `null` when it has no audible content. */
async function renderStemWindow(
  clip: Omit<AudibleAudioClipFields, 'startPpq'> & { startPpq?: number },
  tempo: AudioClipSliceTempo,
  loadAudioAsset: (assetId: string) => Promise<LoadedAudioAsset>,
  stretch: StretchFn | undefined,
): Promise<{ channels: Float32Array[]; sampleRate: number } | null> {
  const rendered = await renderAudibleAudioClipWindow(
    { ...clip, startPpq: clip.startPpq ?? 0 },
    tempo,
    loadAudioAsset,
    { stretch },
  );
  if (!rendered) return null;
  const { channels: window, sampleRate } = rendered;
  if (window.length === 0 || (window[0]?.length ?? 0) === 0) return null;
  return { channels: window, sampleRate };
}

/**
 * Separates an audio clip's played window into harmonic / percussive /
 * residual stems. Returns `[]` when the clip has no asset, the tempo is
 * non-positive, or the source window is empty.
 *
 * @param clip Audio clip to split (needs `assetId`).
 * @param tempo Project tempo/map used by the playback-matching renderer.
 * @param deps Injected asset loader and stem separator.
 * @returns One {@link SeparatedStem} per band (always three when non-empty), in
 *   {@link STEM_KINDS} order.
 */
export async function separateAudioClipStems(
  clip: Omit<AudibleAudioClipFields, 'startPpq'> & { startPpq?: number },
  tempo: AudioClipSliceTempo,
  deps: AudioStemsDeps,
): Promise<SeparatedStem[]> {
  const rendered = await renderStemWindow(clip, tempo, deps.loadAudioAsset, deps.stretch);
  if (!rendered) return [];
  const { channels: window, sampleRate } = rendered;

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

/** Injectable dependencies for {@link separateAudioClipComponents}. */
export interface AudioComponentsDeps {
  /** Loads an audio asset's PCM (defaults to the OPFS asset store). */
  loadAudioAsset: (assetId: string) => Promise<LoadedAudioAsset>;
  /** Warp stretch seam override (tests); production shares the playback wasm seam. */
  stretch?: StretchFn;
  /** Runs the shared-model NMF factorisation; production runs it off-thread. */
  decompose: (
    channels: Float32Array[],
    sampleRate: number,
    count: number,
  ) => Promise<Float32Array[][]>;
}

/**
 * Separates an audio clip's played window into `count` NMF components, one
 * shared model and mask across every channel. Returns `[]` when the clip has
 * no asset, the tempo is non-positive, or the source window is empty.
 *
 * @param clip Audio clip to split (needs `assetId`).
 * @param tempo Project tempo/map used by the playback-matching renderer.
 * @param count Number of components to factor.
 * @param deps Injected asset loader and decomposer.
 * @returns One {@link SeparatedStem} per component, in the order `decompose`
 *   returned them.
 */
export async function separateAudioClipComponents(
  clip: Omit<AudibleAudioClipFields, 'startPpq'> & { startPpq?: number },
  tempo: AudioClipSliceTempo,
  count: number,
  deps: AudioComponentsDeps,
): Promise<SeparatedStem[]> {
  const rendered = await renderStemWindow(clip, tempo, deps.loadAudioAsset, deps.stretch);
  if (!rendered) return [];
  const { channels: window, sampleRate } = rendered;
  const components = await deps.decompose(window, sampleRate, count);
  return components.map((channels, index) => ({ kind: 'component', index, channels, sampleRate }));
}
