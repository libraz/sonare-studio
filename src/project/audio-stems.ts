/**
 * Audio stem separation: runs libsonare's `hpssWithResidual` over an audio
 * clip's played source window, splitting it into harmonic, percussive and
 * residual stems (each keeping the source channel count).
 *
 * Like {@link analyzeAudioClipChords} and {@link analyzeAudioClipMelody} the
 * window is cut with the same fixed-tempo slice as playback, so the stems line
 * up exactly under the source clip. Each channel is separated independently
 * (the separator is mono) and the per-band results are reassembled planar.
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

/** Injectable dependencies for {@link separateAudioClipStems}. */
export interface AudioStemsDeps {
  /** Loads an audio asset's PCM (defaults to the OPFS asset store). */
  loadAudioAsset: (assetId: string) => Promise<LoadedAudioAsset>;
  /** The stem separator. */
  separateStems: AudioStemSeparator;
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
  for (const channel of window) {
    const split = deps.separateStems(channel, sampleRate);
    harmonic.push(split.harmonic);
    percussive.push(split.percussive);
    residual.push(split.residual);
  }
  return [
    { kind: 'harmonic', channels: harmonic, sampleRate },
    { kind: 'percussive', channels: percussive, sampleRate },
    { kind: 'residual', channels: residual, sampleRate },
  ];
}
