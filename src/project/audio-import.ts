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
import {
  MAX_AUDIO_CHANNELS,
  MAX_AUDIO_SAMPLE_RATE,
  MAX_AUDIO_SAMPLES,
  MAX_EXTERNAL_AUDIO_FILE_BYTES,
} from '@/persistence/resource-limits';

/**
 * The analysis functions consumed on import. Matches the libsonare module
 * surface (detectBpm/detectKey), but any compatible implementation works.
 */
export interface AudioAnalysisFunctions {
  /** Unified full analysis; used as a seed for tempo/key/rhythm/dynamics/timbre tags. */
  analyze?: (
    samples: Float32Array,
    sampleRate?: number,
    options?: { tuning?: number },
  ) => {
    bpm?: number;
    bpmConfidence?: number;
    key?: { name?: string; shortName?: string; confidence?: number };
    timeSignature?: { numerator?: number; denominator?: number; confidence?: number };
    rhythm?: {
      syncopation?: number;
      grooveType?: string;
      patternRegularity?: number;
      tempoStability?: number;
      timeSignature?: { numerator?: number; denominator?: number; confidence?: number };
    };
    dynamics?: {
      dynamicRangeDb?: number;
      peakDb?: number;
      rmsDb?: number;
      crestFactor?: number;
      loudnessRangeDb?: number;
      isCompressed?: boolean;
    };
    timbre?: {
      brightness?: number;
      warmth?: number;
      density?: number;
      roughness?: number;
      complexity?: number;
    };
    form?: string;
  };
  /** Detailed tempo analysis; preferred over detectBpm when present. */
  analyzeBpm?: (samples: Float32Array, sampleRate?: number) => { bpm: number; confidence?: number };
  /** Returns the detected tempo in BPM (mono samples + sample rate). */
  detectBpm?: (samples: Float32Array, sampleRate?: number) => number;
  /** Tuning offset from concert pitch, in fractions of a semitone. */
  estimateTuning?: (samples: Float32Array, sampleRate?: number) => number;
  /** Returns the detected key (mono samples + sample rate). */
  detectKey?: (
    samples: Float32Array,
    sampleRate?: number,
  ) => { name: string; shortName?: string; confidence?: number };
  /** Detailed key candidates; used when detectKey is absent. */
  detectKeyCandidates?: (
    samples: Float32Array,
    sampleRate?: number,
  ) => Array<{ key?: { name?: string; shortName?: string; confidence?: number } }>;
  /** Detailed rhythm analysis; used for time-signature/groove tags. */
  analyzeRhythm?: (
    samples: Float32Array,
    sampleRate?: number,
  ) => {
    bpm?: number;
    timeSignature?: { numerator?: number; denominator?: number; confidence?: number };
    grooveType?: string;
  };
  /** Dynamics analysis; used for asset inspector tags. */
  analyzeDynamics?: (
    samples: Float32Array,
    sampleRate?: number,
  ) => {
    dynamicRangeDb?: number;
    peakDb?: number;
    rmsDb?: number;
    crestFactor?: number;
    loudnessRangeDb?: number;
    isCompressed?: boolean;
  };
  /** Timbre analysis; used for asset inspector tags. */
  analyzeTimbre?: (
    samples: Float32Array,
    sampleRate?: number,
  ) => {
    brightness?: number;
    warmth?: number;
    density?: number;
    roughness?: number;
    complexity?: number;
  };
  /** Returns the EBU R128 loudness (mono samples + sample rate). */
  lufs?: (samples: Float32Array, sampleRate?: number) => { integratedLufs: number };
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

/**
 * Resolves the default analysis provider from the wasm module, if loadable.
 * Exposed so callers re-analyzing an already-imported clip (e.g. the clip
 * inspector's "Re-detect tempo") reuse the same detector wiring as import.
 */
export async function resolveAudioAnalysis(): Promise<AudioAnalysisFunctions | null> {
  try {
    const wasm = (await ensureWasm()) as unknown as AudioAnalysisFunctions;
    if (
      typeof wasm.analyzeBpm === 'function' ||
      typeof wasm.detectBpm === 'function' ||
      typeof wasm.detectKey === 'function' ||
      typeof wasm.detectKeyCandidates === 'function' ||
      typeof wasm.analyzeRhythm === 'function' ||
      typeof wasm.analyzeDynamics === 'function' ||
      typeof wasm.analyzeTimbre === 'function' ||
      typeof wasm.analyze === 'function' ||
      typeof wasm.lufs === 'function'
    ) {
      return wasm;
    }
  } catch {
    // No wasm available: analysis is optional.
  }
  return null;
}

/**
 * A recording's offset from concert A440 in fractions of a semitone, the unit
 * the key and chord analyses shift their chroma by, or undefined when the
 * estimator is absent, fails or answers outside [-0.5, 0.5).
 */
export function estimateRecordingTuning(
  estimate: ((samples: Float32Array, sampleRate?: number) => number) | undefined,
  samples: Float32Array,
  sampleRate: number,
): number | undefined {
  if (typeof estimate !== 'function') return undefined;
  try {
    const tuning = estimate(samples, sampleRate);
    return Number.isFinite(tuning) && tuning >= -0.5 && tuning < 0.5 ? tuning : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs tempo/key/loudness analysis over a mono mixdown and returns the tags.
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
  const applyMeter = (
    meter: { numerator?: number; denominator?: number; confidence?: number } | undefined,
  ): void => {
    const numerator = meter?.numerator;
    const denominator = meter?.denominator;
    if (
      Number.isInteger(numerator) &&
      Number.isInteger(denominator) &&
      (numerator ?? 0) > 0 &&
      (denominator ?? 0) > 0
    ) {
      tags.timeSignature = `${numerator}/${denominator}`;
      const confidence = meter?.confidence;
      if (Number.isFinite(confidence)) tags.timeSignatureConfidence = confidence;
    }
  };
  const applyDynamics = (
    dynamics:
      | {
          dynamicRangeDb?: number;
          peakDb?: number;
          rmsDb?: number;
          crestFactor?: number;
          loudnessRangeDb?: number;
          isCompressed?: boolean;
        }
      | undefined,
  ): void => {
    const dynamicRangeDb = dynamics?.dynamicRangeDb;
    const peakDb = dynamics?.peakDb;
    const rmsDb = dynamics?.rmsDb;
    const crestFactor = dynamics?.crestFactor;
    const loudnessRangeDb = dynamics?.loudnessRangeDb;
    if (Number.isFinite(dynamicRangeDb)) tags.dynamicRangeDb = dynamicRangeDb;
    if (Number.isFinite(peakDb)) tags.peakDb = peakDb;
    if (Number.isFinite(rmsDb)) tags.rmsDb = rmsDb;
    if (Number.isFinite(crestFactor)) tags.crestFactor = crestFactor;
    if (Number.isFinite(loudnessRangeDb)) tags.loudnessRangeDb = loudnessRangeDb;
    if (typeof dynamics?.isCompressed === 'boolean') tags.isCompressed = dynamics.isCompressed;
  };
  const applyTimbre = (
    timbre:
      | {
          brightness?: number;
          warmth?: number;
          density?: number;
          roughness?: number;
          complexity?: number;
        }
      | undefined,
  ): void => {
    const brightness = timbre?.brightness;
    const warmth = timbre?.warmth;
    const density = timbre?.density;
    const roughness = timbre?.roughness;
    const complexity = timbre?.complexity;
    if (Number.isFinite(brightness)) tags.brightness = brightness;
    if (Number.isFinite(warmth)) tags.warmth = warmth;
    if (Number.isFinite(density)) tags.density = density;
    if (Number.isFinite(roughness)) tags.roughness = roughness;
    if (Number.isFinite(complexity)) tags.complexity = complexity;
  };
  if (typeof analysis.analyze === 'function') {
    try {
      // An off-pitch recording reads its key on its own pitch grid.
      const tuning = estimateRecordingTuning(analysis.estimateTuning, mono, sampleRate);
      const result = analysis.analyze(
        mono,
        sampleRate,
        tuning === undefined ? undefined : { tuning },
      );
      const bpm = result?.bpm;
      const bpmConfidence = result?.bpmConfidence;
      const keyConfidence = result?.key?.confidence;
      const rhythm = result?.rhythm;
      const syncopation = rhythm?.syncopation;
      const patternRegularity = rhythm?.patternRegularity;
      const tempoStability = rhythm?.tempoStability;
      if (Number.isFinite(bpm) && (bpm ?? 0) > 0) tags.bpm = bpm;
      if (Number.isFinite(bpmConfidence)) tags.bpmConfidence = bpmConfidence;
      const label = result?.key?.shortName || result?.key?.name;
      if (typeof label === 'string' && label.length > 0) tags.key = label;
      if (Number.isFinite(keyConfidence)) tags.keyConfidence = keyConfidence;
      applyMeter(result?.timeSignature ?? rhythm?.timeSignature);
      if (Number.isFinite(syncopation)) tags.syncopation = syncopation;
      if (Number.isFinite(patternRegularity)) tags.patternRegularity = patternRegularity;
      if (Number.isFinite(tempoStability)) tags.tempoStability = tempoStability;
      if (typeof rhythm?.grooveType === 'string' && rhythm.grooveType.length > 0) {
        tags.grooveType = rhythm.grooveType;
      }
      applyDynamics(result?.dynamics);
      applyTimbre(result?.timbre);
      if (typeof result?.form === 'string' && result.form.length > 0) tags.form = result.form;
    } catch {
      // Best effort: fall back to dedicated detectors below.
    }
  }
  if (typeof analysis.analyzeBpm === 'function') {
    try {
      const result = analysis.analyzeBpm(mono, sampleRate);
      if (Number.isFinite(result?.bpm) && result.bpm > 0) tags.bpm = result.bpm;
      if (Number.isFinite(result?.confidence)) tags.bpmConfidence = result.confidence;
    } catch {
      // Best effort: fall back to detectBpm below when present.
    }
  }
  if (tags.bpm === undefined && typeof analysis.detectBpm === 'function') {
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
      if (Number.isFinite(key?.confidence)) tags.keyConfidence = key.confidence;
    } catch {
      // Best effort: no key tag.
    }
  }
  if (tags.key === undefined && typeof analysis.detectKeyCandidates === 'function') {
    try {
      const candidates = analysis.detectKeyCandidates(mono, sampleRate);
      const key = candidates.find((candidate) => candidate.key)?.key;
      const label = key?.shortName || key?.name;
      if (typeof label === 'string' && label.length > 0) tags.key = label;
      const confidence = key?.confidence;
      if (Number.isFinite(confidence)) tags.keyConfidence = confidence;
    } catch {
      // Best effort: no key tag.
    }
  }
  if (typeof analysis.analyzeRhythm === 'function') {
    try {
      const rhythm = analysis.analyzeRhythm(mono, sampleRate);
      const rhythmBpm = rhythm?.bpm;
      if (
        tags.bpm === undefined &&
        typeof rhythmBpm === 'number' &&
        Number.isFinite(rhythmBpm) &&
        rhythmBpm > 0
      ) {
        tags.bpm = rhythmBpm;
      }
      applyMeter(rhythm?.timeSignature);
      if (typeof rhythm?.grooveType === 'string' && rhythm.grooveType.length > 0) {
        tags.grooveType = rhythm.grooveType;
      }
    } catch {
      // Best effort: no rhythm tags.
    }
  }
  if (typeof analysis.analyzeDynamics === 'function') {
    try {
      applyDynamics(analysis.analyzeDynamics(mono, sampleRate));
    } catch {
      // Best effort: no dynamics tags.
    }
  }
  if (typeof analysis.analyzeTimbre === 'function') {
    try {
      applyTimbre(analysis.analyzeTimbre(mono, sampleRate));
    } catch {
      // Best effort: no timbre tags.
    }
  }
  if (typeof analysis.lufs === 'function') {
    try {
      const loudness = analysis.lufs(mono, sampleRate);
      // Silence yields -Infinity; only keep a finite measurement.
      if (Number.isFinite(loudness?.integratedLufs)) tags.lufs = loudness.integratedLufs;
    } catch {
      // Best effort: no loudness tag.
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
  const analysis = options.analysis === undefined ? await resolveAudioAnalysis() : options.analysis;
  const detected = analyzeAudioTags(channels, sampleRate, analysis);
  const tags: AudioAssetTags = { ...detected, ...options.tags };
  const hasTags = Object.values(tags).some((value) => value !== undefined);
  return saveAsset(
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
