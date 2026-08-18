/**
 * Loudness/peak report for the engine-backed offline renderer. Measures
 * sample peak directly and derives true-peak/LUFS through the injected
 * metering seam, matching the renderMixdown report shape.
 */

import type { MixdownDeps, MixdownReport } from '@/export/mixdown';
import { peakDb } from '@/lib/db';

type LoudnessMeasurement =
  | number
  | {
      integratedLufs: number;
      momentaryLufs?: number;
      shortTermLufs?: number;
      loudnessRange?: number;
    };

function applyLoudness(report: MixdownReport, measurement: LoudnessMeasurement): void {
  if (typeof measurement === 'number') {
    if (Number.isFinite(measurement) || measurement === Number.NEGATIVE_INFINITY) {
      report.lufs = measurement;
    }
    return;
  }
  if (
    Number.isFinite(measurement.integratedLufs) ||
    measurement.integratedLufs === Number.NEGATIVE_INFINITY
  ) {
    report.lufs = measurement.integratedLufs;
  }
  if (Number.isFinite(measurement.momentaryLufs)) report.momentaryLufs = measurement.momentaryLufs;
  if (Number.isFinite(measurement.shortTermLufs)) report.shortTermLufs = measurement.shortTermLufs;
  if (Number.isFinite(measurement.loudnessRange)) report.loudnessRange = measurement.loudnessRange;
}

/** One channel's clipping census as the metering seam reports it. */
type ChannelClipping = ReturnType<
  NonNullable<NonNullable<MixdownDeps['metering']>['detectClipping']>
>;

/**
 * Folds the two per-channel censuses into the deliverable's summary. Counts
 * add up across channels (a sample clipped in both is two clipped samples, and
 * the ratio is measured against all samples in the file), while the first
 * region is the earliest either channel reports.
 *
 * @returns The summary, or null when neither channel clipped.
 */
function mergeClipping(
  left: ChannelClipping,
  right: ChannelClipping,
  totalFrames: number,
): MixdownReport['clipping'] {
  const clippedSamples = left.clippedSamples + right.clippedSamples;
  if (!(clippedSamples > 0)) return undefined;
  const starts = [...left.regions, ...right.regions].map((region) => region.startSample);
  return {
    clippedSamples,
    clippingRatio: clippedSamples / (totalFrames * 2),
    maxClippedPeak: Math.max(left.maxClippedPeak, right.maxClippedPeak),
    regionCount: left.regions.length + right.regions.length,
    firstRegionStartSample: starts.length > 0 ? Math.min(...starts) : 0,
  };
}

function stereoMonoDownmix(
  mixL: Float32Array,
  mixR: Float32Array,
  totalFrames: number,
): Float32Array {
  const mono = new Float32Array(totalFrames);
  for (let i = 0; i < totalFrames; i++) mono[i] = 0.5 * (mixL[i] + mixR[i]);
  return mono;
}

/**
 * Builds the loudness/peak report for a stereo deliverable. True-peak and
 * loudness stay absent when their metering calls are unavailable or throw.
 *
 * @param mixL Left channel of the bounced stereo.
 * @param mixR Right channel of the bounced stereo.
 * @param sampleRate Render sample rate in Hz.
 * @param totalFrames Frame count of the render window.
 * @param metering Metering seam (true-peak/LUFS); null skips loudness.
 * @returns The peak (and optional true-peak/LUFS) report.
 */
export function buildReport(
  mixL: Float32Array,
  mixR: Float32Array,
  sampleRate: number,
  totalFrames: number,
  metering: MixdownDeps['metering'] | null,
): MixdownReport {
  let peak = 0;
  for (let i = 0; i < mixL.length; i++) {
    const a = Math.abs(mixL[i]);
    const b = Math.abs(mixR[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  const report: MixdownReport = {
    peakDb: peakDb(peak),
  };
  if (metering?.truePeakDb && totalFrames > 0) {
    try {
      report.truePeakDb = Math.max(
        metering.truePeakDb(mixL, sampleRate),
        metering.truePeakDb(mixR, sampleRate),
      );
    } catch {
      // True peak stays absent when the metering call fails.
    }
  }
  if (totalFrames > 0 && (metering?.interleavedLufs || metering?.integratedLufs)) {
    try {
      if (metering.interleavedLufs) {
        // Channel-weighted BS.1770 over the actual stereo deliverable; a mono
        // downmix would mis-measure decorrelated or panned material.
        const interleaved = new Float32Array(totalFrames * 2);
        for (let i = 0; i < totalFrames; i++) {
          interleaved[2 * i] = mixL[i];
          interleaved[2 * i + 1] = mixR[i];
        }
        applyLoudness(report, metering.interleavedLufs(interleaved, 2, sampleRate));
      } else if (metering.integratedLufs) {
        applyLoudness(
          report,
          metering.integratedLufs(stereoMonoDownmix(mixL, mixR, totalFrames), sampleRate),
        );
      }
    } catch {
      // Loudness stays absent when the metering call fails.
    }
  }
  if (totalFrames > 0 && metering?.detectClipping) {
    try {
      const clipping = mergeClipping(
        metering.detectClipping(mixL, sampleRate),
        metering.detectClipping(mixR, sampleRate),
        totalFrames,
      );
      // Absence means "did not clip", so an all-zero summary is not recorded.
      if (clipping) report.clipping = clipping;
    } catch {
      // Clipping stays absent when the metering call fails.
    }
  }
  if (totalFrames > 0 && metering?.dynamicRangeDb) {
    try {
      const dynamicRange = metering.dynamicRangeDb(
        stereoMonoDownmix(mixL, mixR, totalFrames),
        sampleRate,
      );
      if (Number.isFinite(dynamicRange)) report.dynamicRangeDb = dynamicRange;
    } catch {
      // Dynamic range stays absent when the metering call fails.
    }
  }
  return report;
}
