/**
 * Shared offline-render contract: the option/result/report types, the
 * cancellation error and the injectable wasm seams (mastering chain,
 * loudness metering) used by the engine-backed export renderer
 * (src/export/engine-render.ts) and its worker/UI clients.
 *
 * The rendering itself lives in engine-render.ts, which drives an offline
 * libsonare RealtimeEngine so exports match live playback (lanes, strips,
 * buses/sends, realtime instruments, automation, tempo map) by construction.
 */

import { ensureWasm } from '@/lib/wasm';

/** Thrown when an offline render is cancelled via its shouldCancel option. */
export class MixdownCancelledError extends Error {
  constructor() {
    super('Mixdown render was cancelled');
    this.name = 'MixdownCancelledError';
  }
}

/** An explicit PPQ window to render. */
export interface MixdownRangePpq {
  /** Window start in PPQ (>= 0). */
  startPpq: number;
  /** Window end in PPQ (> startPpq). */
  endPpq: number;
}

/**
 * Render range: 'project' renders from PPQ 0 to the end of the arrangement
 * (including instrument release tails), 'loop' renders the window given by
 * the render options' loopRegion, and an explicit object renders that window.
 */
export type MixdownRange = 'project' | 'loop' | MixdownRangePpq;

/** Progress callback: fraction in [0, 1] plus the stage being entered. */
export type MixdownProgressFn = (progress: number, stage: string) => void;

/** Mastering seam used to apply the project mastering chain to the mix bus. */
export interface MasteringDeps {
  /** One-shot stereo processor invocation (masteringProcessStereo shape). */
  processStereo(
    name: string,
    left: Float32Array,
    right: Float32Array,
    sampleRate: number,
    params: Record<string, number | boolean>,
  ): { left: Float32Array; right: Float32Array };
  /**
   * Whole-chain preset application (masterAudioStereo shape). Omit when the
   * wasm module does not expose it; preset stages are then skipped.
   */
  applyPreset?(
    preset: string,
    left: Float32Array,
    right: Float32Array,
    sampleRate: number,
    overrides?: Record<string, number | boolean>,
  ): {
    left: Float32Array;
    right: Float32Array;
    /** True when the preset's loudness stage stopped short of its target. */
    loudnessTargetLimited?: boolean;
    /** Integrated loudness the preset stage produced, in LUFS. */
    outputLufs?: number;
  };
}

/** Metering seam used for the post-render loudness/peak report. */
export interface MeteringDeps {
  /** Inter-sample (true) peak of one channel in dBFS. */
  truePeakDb?(samples: Float32Array, sampleRate: number): number;
  /** Integrated loudness of a mono downmix in LUFS. */
  integratedLufs?(
    samples: Float32Array,
    sampleRate: number,
  ):
    | number
    | {
        integratedLufs: number;
        momentaryLufs?: number;
        shortTermLufs?: number;
        loudnessRange?: number;
      };
  /**
   * Channel-weighted integrated loudness (ITU-R BS.1770 / EBU R128) measured
   * directly from an interleaved buffer of `frames * channels` samples. This is
   * the standards-correct measurement of a stereo deliverable; the mono
   * `integratedLufs` is only a fallback for builds without this seam.
   */
  interleavedLufs?(
    samples: Float32Array,
    channels: number,
    sampleRate: number,
  ):
    | number
    | {
        integratedLufs: number;
        momentaryLufs?: number;
        shortTermLufs?: number;
        loudnessRange?: number;
      };
  /** Dynamic range of a mono downmix in dB. */
  dynamicRangeDb?(samples: Float32Array, sampleRate: number): number;
  /**
   * Clipped-sample census of one channel. The engine owns the definition of
   * "clipped" (threshold and minimum run length), so the export warning and
   * the engine agree instead of the app carrying its own rule.
   */
  detectClipping?(
    samples: Float32Array,
    sampleRate: number,
  ): {
    clippedSamples: number;
    maxClippedPeak: number;
    regions: ReadonlyArray<{ startSample: number; length: number }>;
  };
}

/** All injectable wasm seams of an offline render. */
export interface MixdownDeps {
  /** Mastering chain seam; null = the mastering chain is skipped. */
  mastering: MasteringDeps | null;
  /** Metering seam; null = the report carries the sample peak only. */
  metering: MeteringDeps | null;
}

/** One stem of an offline render. */
export interface MixdownStem {
  /** Source kind. Omitted on older per-track callers; treat as 'track'. */
  source?: 'track' | 'bus' | 'master';
  /** Index of the track in the document's track list, or a negative non-track sentinel. */
  trackIndex: number;
  /** Mixer bus id for bus/return stems. */
  busId?: string;
  /** Index of the mixer bus in the document bus list. */
  busIndex?: number;
  /** Display name. */
  name: string;
  /** Planar stereo buffers covering the full render window. */
  channels: [Float32Array, Float32Array];
  /** Loudness/peak measurements for this stem, when metering was available. */
  report?: MixdownReport;
}

/**
 * Clipping census of a rendered deliverable.
 *
 * A summary rather than the engine's region list: a hard-limited master can
 * report thousands of regions, and they would cross the export-worker boundary
 * on every render to say what the counts already say.
 */
export interface ClippingSummary {
  /** Clipped samples across both channels. */
  clippedSamples: number;
  /** Clipped samples as a fraction of all samples in the deliverable. */
  clippingRatio: number;
  /** Largest absolute sample value inside a clipped run (linear). */
  maxClippedPeak: number;
  /** Contiguous clipped runs across both channels. */
  regionCount: number;
  /** Frame index where clipping first appears, for a jump-to-position. */
  firstRegionStartSample: number;
}

/** Loudness/peak measurements of the rendered mix. */
export interface MixdownReport {
  /** Sample peak in dBFS (-Infinity for silence). Always present. */
  peakDb: number;
  /** Inter-sample (true) peak in dBFS; absent without a metering seam. */
  truePeakDb?: number;
  /** Integrated loudness of the mono downmix in LUFS; absent without a metering seam. */
  lufs?: number;
  /** Momentary loudness in LUFS; absent when the metering seam does not provide it. */
  momentaryLufs?: number;
  /** Short-term loudness in LUFS; absent when the metering seam does not provide it. */
  shortTermLufs?: number;
  /** Loudness range in LU; absent when the metering seam does not provide it. */
  loudnessRange?: number;
  /** Dynamic range in dB; absent without a dynamic-range metering seam. */
  dynamicRangeDb?: number;
  /**
   * Clipping census of the deliverable, summed over both channels. Absent when
   * nothing clipped or the metering seam does not detect clipping — its
   * presence alone means the render clipped.
   *
   * A peak reading answers "how far over", this answers "how much and where":
   * one stray inter-sample overshoot and a squared-off chorus both read as
   * peak > 0 dBFS.
   */
  clipping?: ClippingSummary;
  /** Non-fatal renderer limitations that affected this bounce. */
  limitations?: ExportLimitation[];
  /** Non-fatal media omissions that made the rendered deliverable incomplete. */
  mediaIssues?: ExportMediaIssue[];
}

export interface ExportMediaIssue {
  kind: 'audio-asset' | 'soundfont';
  id: string;
  reason: 'missing-or-unreadable';
  message?: string;
}

/**
 * A non-fatal offline-render limitation, structured for localization at the UI
 * (the strings are assembled by the export issue formatter, not stored here).
 */
export type ExportLimitation =
  | {
      kind: 'mastering-automation-at-render-start';
      /**
       * The "<processor>.<paramName>" pairs that stayed frozen. Absent means
       * the whole mastering rack did, which is what a preflight reports
       * before it knows which processors the engine can drive.
       */
      params?: string[];
    }
  /** The mastering preset's loudness stage finished below its target. */
  | { kind: 'mastering-loudness-target-limited'; outputLufs: number }
  /** Streaming callbacks cannot retain the full waveform for post-render metering. */
  | {
      kind: 'streaming-metering-unavailable';
      measurements: Array<'lufs' | 'true-peak'>;
    };

/** Result of an offline render. */
export interface MixdownResult {
  /** Planar stereo mixdown buffers. */
  channels: [Float32Array, Float32Array];
  /** Output sample rate in Hz. */
  sampleRate: number;
  /** Render length in frames. */
  totalFrames: number;
  /** Loudness/peak report of the mixdown. */
  report: MixdownReport;
  /** Track and optional bus/return stems; present only when the stems option is true. */
  stems?: MixdownStem[];
}

/** Narrow runtime view of the wasm module used to build the default seams. */
type MixdownWasmSurface = Partial<
  Pick<
    typeof import('@/wasm/index.js'),
    | 'masteringProcessStereo'
    | 'masterAudioStereo'
    | 'meteringTruePeakDb'
    | 'lufs'
    | 'lufsInterleaved'
    | 'meteringDynamicRange'
    | 'meteringDetectClipping'
  >
>;

/**
 * Builds the default render seams from the loaded wasm module, degrading
 * each seam to null/absent when the module (an older build or a minimal test
 * mock) does not expose the underlying function.
 */
export async function createWasmMixdownDeps(): Promise<MixdownDeps> {
  const wasm: MixdownWasmSurface = await ensureWasm();
  const processStereo = wasm.masteringProcessStereo;
  let mastering: MasteringDeps | null = null;
  if (typeof processStereo === 'function') {
    mastering = {
      processStereo: (name, left, right, sampleRate, params) => {
        const out = processStereo(name as never, left, right, sampleRate, params);
        return { left: out.left, right: out.right };
      },
    };
    const masterAudioStereo = wasm.masterAudioStereo;
    if (typeof masterAudioStereo === 'function') {
      mastering.applyPreset = (preset, left, right, sampleRate, overrides) => {
        const out = masterAudioStereo(left, right, sampleRate, preset as never, overrides);
        return {
          left: out.left,
          right: out.right,
          loudnessTargetLimited: out.loudnessTargetLimited,
          outputLufs: out.outputLufs,
        };
      };
    }
  }
  const metering: MeteringDeps = {};
  const truePeakDb = wasm.meteringTruePeakDb;
  if (typeof truePeakDb === 'function') {
    metering.truePeakDb = (samples, sampleRate) => truePeakDb(samples, sampleRate);
  }
  const lufs = wasm.lufs;
  if (typeof lufs === 'function') {
    metering.integratedLufs = (samples, sampleRate) => lufs(samples, sampleRate);
  }
  const lufsInterleaved = wasm.lufsInterleaved;
  if (typeof lufsInterleaved === 'function') {
    metering.interleavedLufs = (samples, channels, sampleRate) =>
      lufsInterleaved(samples, channels, sampleRate);
  }
  const dynamicRange = wasm.meteringDynamicRange;
  if (typeof dynamicRange === 'function') {
    metering.dynamicRangeDb = (samples, sampleRate) =>
      dynamicRange(samples, sampleRate).dynamicRangeDb;
  }
  const detectClipping = wasm.meteringDetectClipping;
  if (typeof detectClipping === 'function') {
    metering.detectClipping = (samples, sampleRate) => detectClipping(samples, sampleRate);
  }
  return {
    mastering,
    metering:
      metering.truePeakDb ||
      metering.integratedLufs ||
      metering.interleavedLufs ||
      metering.dynamicRangeDb ||
      metering.detectClipping
        ? metering
        : null,
  };
}
