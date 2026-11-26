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

import type {
  LufsResult,
  MasteringChainConfig,
  MasteringPreset,
  MasteringProcessorParams,
  SoloProcessor,
} from '@libraz/libsonare';
import { ensureWasm } from '@/lib/wasm';
import type { InsertParamValue } from '@/project/mixer';

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
  /** One-shot stereo processor invocation (masteringApplyProcessorStereo shape). */
  processStereo(
    name: SoloProcessor,
    left: Float32Array,
    right: Float32Array,
    sampleRate: number,
    params: Record<string, InsertParamValue>,
  ): { left: Float32Array; right: Float32Array };
  /**
   * Whole-chain preset application (masterAudioStereo shape). Omit when the
   * wasm module does not expose it; preset stages are then skipped.
   */
  applyPreset?(
    preset: MasteringPreset,
    left: Float32Array,
    right: Float32Array,
    sampleRate: number,
    overrides?: MasteringChainConfig,
  ): {
    left: Float32Array;
    right: Float32Array;
    /** The chain's own loudness summary; absent when the seam does not report one. */
    report?: MasteringPresetReport;
  };
}

/** Loudness summary the mastering chain reported for its preset stage. */
export interface MasteringPresetReport {
  /** Integrated loudness of the stage output in LUFS. */
  outputLufs: number;
  /** True when peak headroom kept the stage from reaching its loudness target. */
  loudnessTargetLimited: boolean;
}

/** Metering seam used for the post-render loudness/peak report. */
export interface MeteringDeps {
  /** Inter-sample (true) peak of one channel in dBTP. */
  truePeakDbtp?(samples: Float32Array, sampleRate: number): number;
  /** Integrated loudness of a mono downmix in LUFS. */
  integratedLufs?(samples: Float32Array, sampleRate: number): LufsResult;
  /**
   * Channel-weighted integrated loudness (ITU-R BS.1770 / EBU R128) measured
   * directly from planar channels of equal length. This is the
   * standards-correct measurement of a stereo deliverable; the mono
   * `integratedLufs` is only a fallback for builds without this seam.
   */
  multichannelLufs?(channels: Float32Array[], sampleRate: number): LufsResult;
  /** Dynamic range of a mono downmix in dB; absent when it cannot be measured. */
  dynamicRangeDb?(samples: Float32Array, sampleRate: number): number | undefined;
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
  /** Inter-sample (true) peak in dBTP; -Infinity for silence, absent without a metering seam. */
  truePeakDbtp?: number;
  /** Integrated loudness in LUFS; -Infinity for silence, absent without a metering seam. */
  lufs?: number;
  /** Momentary loudness in LUFS; -Infinity for silence, absent when too short or unmeasured. */
  momentaryLufs?: number;
  /** Short-term loudness in LUFS; -Infinity for silence, absent when too short or unmeasured. */
  shortTermLufs?: number;
  /** Loudness range in LU; absent when silence or no gated 3 s block prevents measurement. */
  loudnessRangeLu?: number;
  /** Dynamic range in dB; +Infinity for a silent low-percentile window, absent when unmeasured. */
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
  /** What the mastering chain reported for its preset stage; absent when no preset ran. */
  masteringPreset?: MasteringPresetReport;
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
  /** More warped clips sounded at once than stretch voices; the extras played repitched. */
  | { kind: 'warp-voices-exceeded'; overflows: number }
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
    typeof import('@libraz/libsonare'),
    | 'masteringApplyProcessorStereo'
    | 'masterAudioStereo'
    | 'meteringTruePeakDbtp'
    | 'lufs'
    | 'lufsMultichannel'
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
  const processStereo = wasm.masteringApplyProcessorStereo;
  let mastering: MasteringDeps | null = null;
  if (typeof processStereo === 'function') {
    mastering = {
      processStereo: (name, left, right, sampleRate, params) => {
        const out = processStereo({
          processor: name,
          left,
          right,
          sampleRate,
          params: params as MasteringProcessorParams<SoloProcessor>,
        });
        return { left: out.left, right: out.right };
      },
    };
    const masterAudioStereo = wasm.masterAudioStereo;
    if (typeof masterAudioStereo === 'function') {
      mastering.applyPreset = (preset, left, right, sampleRate, overrides) => {
        const out = masterAudioStereo({
          left,
          right,
          sampleRate,
          preset,
          ...(overrides ? { overrides } : {}),
        });
        return {
          left: out.left,
          right: out.right,
          report: {
            outputLufs: out.outputLufs,
            loudnessTargetLimited: out.loudnessTargetLimited,
          },
        };
      };
    }
  }
  const metering: MeteringDeps = {};
  const truePeakDbtp = wasm.meteringTruePeakDbtp;
  if (typeof truePeakDbtp === 'function') {
    metering.truePeakDbtp = (samples, sampleRate) => truePeakDbtp(samples, sampleRate);
  }
  const lufs = wasm.lufs;
  if (typeof lufs === 'function') {
    metering.integratedLufs = (samples, sampleRate) => lufs(samples, sampleRate);
  }
  const lufsMultichannel = wasm.lufsMultichannel;
  if (typeof lufsMultichannel === 'function') {
    metering.multichannelLufs = (channels, sampleRate) =>
      lufsMultichannel({ channels, sampleRate });
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
      metering.truePeakDbtp ||
      metering.integratedLufs ||
      metering.multichannelLufs ||
      metering.dynamicRangeDb ||
      metering.detectClipping
        ? metering
        : null,
  };
}
