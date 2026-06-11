/**
 * Audio import: turns decoded sample buffers into stored audio assets.
 *
 * The flow is split so the core stays testable without browser audio:
 * - {@link ingestAudioBuffer} is pure data-in/data-out (plus asset-store I/O):
 *   it saves the buffers as an asset and optionally analyzes tempo/key.
 * - {@link decodeAndIngest} is the thin browser wrapper that decodes a file
 *   via OfflineAudioContext.decodeAudioData (stereo is preserved; no mono
 *   downmix) and forwards to ingestAudioBuffer.
 */

import { ensureWasm } from '@/lib/wasm';
import { type AudioAssetMeta, type AudioAssetTags, saveAsset } from '@/persistence/assets';

/**
 * The analysis functions consumed on import. Matches the libsonare module
 * surface (detectBpm/detectKey), but any compatible implementation works.
 */
export interface AudioAnalysisFunctions {
  /** Returns the detected tempo in BPM (mono samples + sample rate). */
  detectBpm?: (samples: Float32Array, sampleRate?: number) => number;
  /** Returns the detected key (mono samples + sample rate). */
  detectKey?: (samples: Float32Array, sampleRate?: number) => { name: string; shortName?: string };
}

/** Options for {@link ingestAudioBuffer}. */
export interface IngestAudioOptions {
  /** Asset id override; defaults to the deterministic content hash. */
  id?: string;
  /** Tags to store as-is (merged under analysis results). */
  tags?: AudioAssetTags;
  /**
   * Analysis provider: pass functions to use, null to disable analysis, or
   * leave undefined to use the libsonare wasm module when it exposes
   * detectBpm/detectKey (a graceful no-op otherwise).
   */
  analysis?: AudioAnalysisFunctions | null;
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

/**
 * Mixes planar channels down to one mono buffer (equal-weight average).
 * Used for analysis only; stored assets keep their full channel count.
 *
 * @param channels Planar channel buffers of equal length.
 * @returns A new mono buffer (empty for empty input).
 */
export function mixdownToMono(channels: ReadonlyArray<Float32Array>): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return new Float32Array(channels[0]);
  const frames = channels[0].length;
  const out = new Float32Array(frames);
  for (const channel of channels) {
    for (let i = 0; i < frames; i++) out[i] += channel[i];
  }
  const scale = 1 / channels.length;
  for (let i = 0; i < frames; i++) out[i] *= scale;
  return out;
}

/** Resolves the default analysis provider from the wasm module, if loadable. */
async function defaultAnalysis(): Promise<AudioAnalysisFunctions | null> {
  try {
    const wasm = (await ensureWasm()) as unknown as AudioAnalysisFunctions;
    if (typeof wasm.detectBpm === 'function' || typeof wasm.detectKey === 'function') {
      return wasm;
    }
  } catch {
    // No wasm available: analysis is optional.
  }
  return null;
}

/**
 * Runs tempo/key analysis over a mono mixdown and returns the resulting tags.
 * Every analysis step is best-effort: detector errors or unusable results
 * yield no tag rather than failing the import.
 *
 * @param channels Planar channel buffers.
 * @param sampleRate Sample rate of the buffers in Hz.
 * @param analysis Analysis functions (skipped when absent).
 * @returns Tags with the successful detections (possibly empty).
 */
export function analyzeAudioTags(
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  analysis: AudioAnalysisFunctions | null | undefined,
): AudioAssetTags {
  const tags: AudioAssetTags = {};
  if (!analysis || channels.length === 0 || channels[0].length === 0) return tags;
  const mono = mixdownToMono(channels);
  if (typeof analysis.detectBpm === 'function') {
    try {
      const bpm = analysis.detectBpm(mono, sampleRate);
      if (Number.isFinite(bpm) && bpm > 0) tags.bpm = bpm;
    } catch {
      // Best effort: no bpm tag.
    }
  }
  if (typeof analysis.detectKey === 'function') {
    try {
      const key = analysis.detectKey(mono, sampleRate);
      const label = key?.shortName || key?.name;
      if (typeof label === 'string' && label.length > 0) tags.key = label;
    } catch {
      // Best effort: no key tag.
    }
  }
  return tags;
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
  const analysis = options.analysis === undefined ? await defaultAnalysis() : options.analysis;
  const detected = analyzeAudioTags(channels, sampleRate, analysis);
  const tags: AudioAssetTags = { ...detected, ...options.tags };
  return saveAsset(
    {
      name,
      sampleRate,
      ...(options.id !== undefined ? { id: options.id } : {}),
      ...(tags.bpm !== undefined || tags.key !== undefined ? { tags } : {}),
    },
    channels,
  );
}

/** Strips a trailing file extension from a file name. */
function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/**
 * Decodes an audio file in the browser and stores it as an asset.
 *
 * Decoding uses OfflineAudioContext.decodeAudioData, which preserves the
 * source channel count (stereo stays stereo) but resamples to the context
 * rate (`options.sampleRate`, default 48000 Hz). Decoding allocates no audio
 * output and produces no sound.
 *
 * Not testable under jsdom (no OfflineAudioContext); all logic beyond the
 * decode lives in {@link ingestAudioBuffer}.
 *
 * @param file Audio file (or its raw bytes).
 * @param options Optional name/rate/id/tags/analysis overrides.
 * @returns The stored asset metadata.
 */
export async function decodeAndIngest(
  file: File | Blob | ArrayBuffer,
  options: DecodeAndIngestOptions = {},
): Promise<AudioAssetMeta> {
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
  const channels: Float32Array[] = [];
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    channels.push(new Float32Array(decoded.getChannelData(c)));
  }
  return ingestAudioBuffer(channels, decoded.sampleRate, name, options);
}
