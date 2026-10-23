/**
 * Audio import: turns decoded sample buffers into stored audio assets.
 *
 * The flow is split so the core stays testable without browser audio:
 * - {@link ingestAudioBuffer} is pure data-in/data-out (plus asset-store I/O):
 *   it saves the buffers as an asset after reading its tags in a worker.
 * - {@link decodeAndIngest} is the thin browser wrapper that decodes a file
 *   via OfflineAudioContext.decodeAudioData (stereo is preserved; no mono
 *   downmix) and forwards to ingestAudioBuffer.
 */

import { downmixToMono } from '@/lib/audio-channels';
import type { AudioAssetTransaction } from '@/persistence/asset-transaction';
import {
  type AudioAssetMeta,
  type AudioAssetTags,
  interleaveChannels,
  saveAsset,
} from '@/persistence/assets';
import {
  MAX_AUDIO_CHANNELS,
  MAX_AUDIO_SAMPLE_RATE,
  MAX_AUDIO_SAMPLES,
  MAX_EXTERNAL_AUDIO_FILE_BYTES,
} from '@/persistence/resource-limits';
import { analyzeAudioTagsInWorker } from './audio-analysis-client';
import { type AnalysisProgress, type AudioAnalysisFunctions, analyzeAudioTags } from './audio-tags';

/** Options for {@link ingestAudioBuffer}. */
export interface IngestAudioOptions {
  /** Asset id override; defaults to the deterministic content hash. */
  id?: string;
  /** Tags to store as-is (merged under analysis results). */
  tags?: AudioAssetTags;
  /**
   * Analysis provider: pass functions to run in place, null to disable
   * analysis, or leave undefined to run the libsonare detectors in a worker.
   */
  analysis?: AudioAnalysisFunctions | null;
  /** Receives the share of the tag analysis done so far, in [0, 1]. */
  onProgress?: AnalysisProgress;
  /**
   * Asset writer; pass a transaction's save so the asset is leased before the
   * store's awaits. Defaults to an unleased saveAsset.
   */
  save?: AudioAssetTransaction['save'];
}

/** Options for {@link decodeAndIngest}. */
export interface DecodeAndIngestOptions extends IngestAudioOptions {
  /** Asset display name; defaults to the file name (or "Imported audio"). */
  name?: string;
  /**
   * Decode context sample rate in Hz (default 48000). decodeAudioData
   * resamples to the context rate, so this is the stored asset rate.
   */
  sampleRate?: number;
}

/** Rejects an oversized browser decode before copying any channel buffers. */
function preflightDecodedAudio(decoded: AudioBuffer): void {
  const { numberOfChannels, length, sampleRate } = decoded;
  const totalSamples = numberOfChannels * length;
  if (
    !Number.isInteger(numberOfChannels) ||
    numberOfChannels < 1 ||
    numberOfChannels > MAX_AUDIO_CHANNELS ||
    !Number.isInteger(length) ||
    length < 1 ||
    !Number.isSafeInteger(totalSamples) ||
    totalSamples > MAX_AUDIO_SAMPLES
  ) {
    throw new RangeError(
      `Decoded audio sample count must be between 1 and ${MAX_AUDIO_SAMPLES}, got ${totalSamples}`,
    );
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > MAX_AUDIO_SAMPLE_RATE) {
    throw new RangeError(
      `Decoded audio sample rate must be between 1 and ${MAX_AUDIO_SAMPLE_RATE}, got ${sampleRate}`,
    );
  }
}

/** Tags are best effort: a worker that cannot start or load leaves the asset untagged. */
async function detectTags(
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  options: IngestAudioOptions,
): Promise<AudioAssetTags> {
  if (options.analysis === null) return {};
  const mono = downmixToMono(channels, { copy: true });
  // Loudness is channel-summed on the stored channels; the detectors read the mono mixdown.
  const loudness = { interleaved: interleaveChannels(channels), channels: channels.length };
  if (options.analysis !== undefined) {
    return analyzeAudioTags(mono, sampleRate, options.analysis, options.onProgress, loudness);
  }
  try {
    return await analyzeAudioTagsInWorker(mono, sampleRate, {
      onProgress: options.onProgress,
      loudness,
    });
  } catch {
    return {};
  }
}

/**
 * Stores decoded audio buffers as an asset, optionally analyzing tempo/key
 * into the asset tags. Stereo (or any channel count) is preserved.
 *
 * @param channels Planar channel buffers of equal length (>= 1 channel).
 * @param sampleRate Sample rate of the buffers in Hz (> 0).
 * @param name Asset display name.
 * @param options Optional id/tags/analysis overrides.
 * @returns The stored asset metadata (deterministic id by default).
 */
export async function ingestAudioBuffer(
  channels: Float32Array[],
  sampleRate: number,
  name: string,
  options: IngestAudioOptions = {},
): Promise<AudioAssetMeta> {
  const detected = await detectTags(channels, sampleRate, options);
  const tags: AudioAssetTags = { ...detected, ...options.tags };
  const hasTags = Object.values(tags).some((value) => value !== undefined);
  const save = options.save ?? saveAsset;
  return save(
    {
      name,
      sampleRate,
      ...(options.id !== undefined ? { id: options.id } : {}),
      ...(hasTags ? { tags } : {}),
    },
    channels,
  );
}

/** Strips a trailing file extension from a file name. */
function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/** Planar result of {@link decodeAudioFile}. */
export interface DecodedAudioFile {
  /** Planar channel buffers (the source channel count is preserved). */
  channels: Float32Array[];
  /** Sample rate of the buffers in Hz (the decode context rate). */
  sampleRate: number;
  /** Display name taken from the file (extension stripped). */
  name: string;
}

/**
 * Decodes an audio file in the browser into planar buffers, without storing
 * anything.
 *
 * Decoding uses OfflineAudioContext.decodeAudioData, which preserves the
 * source channel count (stereo stays stereo) but resamples to the context
 * rate (`options.sampleRate`, default 48000 Hz). Decoding allocates no audio
 * output and produces no sound.
 *
 * Not testable under jsdom (no OfflineAudioContext).
 *
 * @param file Audio file (or its raw bytes).
 * @param options Optional name/rate overrides.
 * @returns The decoded channels, their sample rate and the display name.
 */
export async function decodeAudioFile(
  file: File | Blob | ArrayBuffer,
  options: { name?: string; sampleRate?: number } = {},
): Promise<DecodedAudioFile> {
  const inputByteLength = file instanceof ArrayBuffer ? file.byteLength : file.size;
  if (inputByteLength > MAX_EXTERNAL_AUDIO_FILE_BYTES) {
    throw new RangeError(
      `Audio import exceeds the ${MAX_EXTERNAL_AUDIO_FILE_BYTES} byte compressed-file limit`,
    );
  }
  const bytes = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  const name =
    options.name ??
    (typeof File !== 'undefined' && file instanceof File
      ? stripExtension(file.name)
      : 'Imported audio');
  const OfflineCtx = globalThis.OfflineAudioContext;
  if (typeof OfflineCtx !== 'function') {
    throw new Error('Audio decoding is unavailable: OfflineAudioContext is not supported');
  }
  const ctx = new OfflineCtx(2, 1, options.sampleRate ?? 48000);
  const decoded = await ctx.decodeAudioData(bytes.slice(0));
  preflightDecodedAudio(decoded);
  const channels: Float32Array[] = [];
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    channels.push(new Float32Array(decoded.getChannelData(c)));
  }
  return { channels, sampleRate: decoded.sampleRate, name };
}

/**
 * Decodes an audio file in the browser and stores it as an asset.
 *
 * Not testable under jsdom (no OfflineAudioContext); all logic beyond the
 * decode lives in {@link decodeAudioFile} and {@link ingestAudioBuffer}.
 *
 * @param file Audio file (or its raw bytes).
 * @param options Optional name/rate/id/tags/analysis overrides.
 * @returns The stored asset metadata.
 */
export async function decodeAndIngest(
  file: File | Blob | ArrayBuffer,
  options: DecodeAndIngestOptions = {},
): Promise<AudioAssetMeta> {
  const decoded = await decodeAudioFile(file, options);
  return ingestAudioBuffer(decoded.channels, decoded.sampleRate, decoded.name, options);
}
