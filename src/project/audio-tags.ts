/**
 * Asset tag analysis: tempo, key, meter, rhythm, dynamics, timbre and loudness
 * read from a mono buffer (loudness from the stored channels).
 *
 * Each tag comes from its dedicated detector. The library's one-call full
 * analysis is not used: it adds only a form label nothing reads, and spends
 * more than half its time on melody tracking the tags never use. Every step is
 * best-effort: a detector error or an unusable value yields no tag rather than
 * failing the import. Pure module, so the analysis worker can load it.
 */

import type { AudioAssetTags } from '@/persistence/assets';

interface MeterReading {
  numerator?: number;
  denominator?: number;
  confidence?: number;
}

/**
 * The analysis functions consumed on import. Matches the libsonare module
 * surface, but any compatible implementation works.
 */
export interface AudioAnalysisFunctions {
  /** Detailed tempo analysis; preferred over detectBpm when present. */
  analyzeBpm?: (samples: Float32Array, sampleRate?: number) => { bpm: number; confidence?: number };
  /** Returns the detected tempo in BPM (mono samples + sample rate). */
  detectBpm?: (samples: Float32Array, sampleRate?: number) => number;
  /** Returns the detected key; an off-pitch recording is read on its own pitch grid. */
  detectKey?: (
    samples: Float32Array,
    sampleRate?: number,
    options?: { tuning?: number | 'auto' },
  ) => { name: string; shortName?: string; confidence?: number };
  /** Detailed key candidates; used when detectKey is absent. */
  detectKeyCandidates?: (
    samples: Float32Array,
    sampleRate?: number,
  ) => Array<{ key?: { name?: string; shortName?: string; confidence?: number } }>;
  /** Rhythm analysis; used for meter, groove and rhythm-feel tags. */
  analyzeRhythm?: (
    samples: Float32Array,
    sampleRate?: number,
  ) => {
    bpm?: number;
    timeSignature?: MeterReading;
    grooveType?: string;
    syncopation?: number;
    patternRegularity?: number;
    tempoStability?: number;
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
  /** Returns the BS.1770 channel-summed loudness of an interleaved buffer. */
  lufsInterleaved?: (
    samples: Float32Array,
    channels: number,
    sampleRate?: number,
  ) => { integratedLufs: number };
}

/** The stored channels, interleaved, for the loudness measurement. */
export interface LoudnessInput {
  /** Frame-major samples of every channel. */
  interleaved: Float32Array;
  /** Channel count of `interleaved`. */
  channels: number;
}

/** Receives the share of the analysis done so far, in [0, 1]. */
export type AnalysisProgress = (fraction: number) => void;

/** Relative cost of each step, measured on a long recording; drives progress. */
const STEP_COST = {
  bpm: 0.8,
  key: 2.2,
  rhythm: 0.8,
  dynamics: 0.2,
  timbre: 0.9,
  lufs: 0.3,
} as const;
const TOTAL_COST = Object.values(STEP_COST).reduce((sum, cost) => sum + cost, 0);

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Runs a detector, swallowing its failure: a missing tag is the answer. */
function attempt(run: () => void): void {
  try {
    run();
  } catch {
    // Best effort: no tag from this detector.
  }
}

/**
 * Runs every available detector over a mono buffer and returns the tags.
 *
 * @param mono Mono samples.
 * @param sampleRate Sample rate in Hz.
 * @param analysis Detectors (skipped when absent).
 * @param onProgress Called after each step with the share done.
 * @param loudness Stored channels to measure loudness on; without them the mono
 *   buffer is measured. A multichannel input needs `lufsInterleaved`, since a
 *   downmix reads quieter than the channel-summed loudness.
 * @returns Tags with the successful detections (possibly empty).
 */
export function analyzeAudioTags(
  mono: Float32Array,
  sampleRate: number,
  analysis: AudioAnalysisFunctions | null | undefined,
  onProgress?: AnalysisProgress,
  loudness?: LoudnessInput,
): AudioAssetTags {
  const tags: AudioAssetTags = {};
  if (!analysis || mono.length === 0) return tags;
  let done = 0;
  const step = (cost: number, run: () => void): void => {
    attempt(run);
    done += cost;
    onProgress?.(Math.min(1, done / TOTAL_COST));
  };

  step(STEP_COST.bpm, () => {
    if (typeof analysis.analyzeBpm === 'function') {
      const result = analysis.analyzeBpm(mono, sampleRate);
      if (finite(result?.bpm) && result.bpm > 0) tags.bpm = result.bpm;
      if (finite(result?.confidence)) tags.bpmConfidence = result.confidence;
    }
    if (tags.bpm === undefined && typeof analysis.detectBpm === 'function') {
      const bpm = analysis.detectBpm(mono, sampleRate);
      if (finite(bpm) && bpm > 0) tags.bpm = bpm;
    }
  });

  step(STEP_COST.key, () => {
    let key: { name?: string; shortName?: string; confidence?: number } | undefined;
    if (typeof analysis.detectKey === 'function') {
      key = analysis.detectKey(mono, sampleRate, { tuning: 'auto' });
    } else if (typeof analysis.detectKeyCandidates === 'function') {
      key = analysis.detectKeyCandidates(mono, sampleRate).find((candidate) => candidate.key)?.key;
    }
    const label = key?.shortName || key?.name;
    if (typeof label === 'string' && label.length > 0) tags.key = label;
    if (finite(key?.confidence)) tags.keyConfidence = key.confidence;
  });

  step(STEP_COST.rhythm, () => {
    if (typeof analysis.analyzeRhythm !== 'function') return;
    const rhythm = analysis.analyzeRhythm(mono, sampleRate);
    if (tags.bpm === undefined && finite(rhythm?.bpm) && rhythm.bpm > 0) tags.bpm = rhythm.bpm;
    const meter = rhythm?.timeSignature;
    if (
      Number.isInteger(meter?.numerator) &&
      Number.isInteger(meter?.denominator) &&
      (meter?.numerator ?? 0) > 0 &&
      (meter?.denominator ?? 0) > 0
    ) {
      tags.timeSignature = `${meter?.numerator}/${meter?.denominator}`;
      if (finite(meter?.confidence)) tags.timeSignatureConfidence = meter.confidence;
    }
    if (typeof rhythm?.grooveType === 'string' && rhythm.grooveType.length > 0) {
      tags.grooveType = rhythm.grooveType;
    }
    if (finite(rhythm?.syncopation)) tags.syncopation = rhythm.syncopation;
    if (finite(rhythm?.patternRegularity)) tags.patternRegularity = rhythm.patternRegularity;
    if (finite(rhythm?.tempoStability)) tags.tempoStability = rhythm.tempoStability;
  });

  step(STEP_COST.dynamics, () => {
    if (typeof analysis.analyzeDynamics !== 'function') return;
    const dynamics = analysis.analyzeDynamics(mono, sampleRate);
    if (finite(dynamics?.dynamicRangeDb)) tags.dynamicRangeDb = dynamics.dynamicRangeDb;
    if (finite(dynamics?.peakDb)) tags.peakDb = dynamics.peakDb;
    if (finite(dynamics?.rmsDb)) tags.rmsDb = dynamics.rmsDb;
    if (finite(dynamics?.crestFactor)) tags.crestFactor = dynamics.crestFactor;
    if (finite(dynamics?.loudnessRangeDb)) tags.loudnessRangeDb = dynamics.loudnessRangeDb;
    if (typeof dynamics?.isCompressed === 'boolean') tags.isCompressed = dynamics.isCompressed;
  });

  step(STEP_COST.timbre, () => {
    if (typeof analysis.analyzeTimbre !== 'function') return;
    const timbre = analysis.analyzeTimbre(mono, sampleRate);
    if (finite(timbre?.brightness)) tags.brightness = timbre.brightness;
    if (finite(timbre?.warmth)) tags.warmth = timbre.warmth;
    if (finite(timbre?.density)) tags.density = timbre.density;
    if (finite(timbre?.roughness)) tags.roughness = timbre.roughness;
    if (finite(timbre?.complexity)) tags.complexity = timbre.complexity;
  });

  step(STEP_COST.lufs, () => {
    // Silence yields -Infinity; only keep a finite measurement.
    let measured: { integratedLufs: number } | undefined;
    if (loudness !== undefined && typeof analysis.lufsInterleaved === 'function') {
      measured = analysis.lufsInterleaved(loudness.interleaved, loudness.channels, sampleRate);
    } else if ((loudness === undefined || loudness.channels === 1) && analysis.lufs) {
      measured = analysis.lufs(mono, sampleRate);
    }
    if (finite(measured?.integratedLufs)) tags.lufs = measured.integratedLufs;
  });

  return tags;
}
