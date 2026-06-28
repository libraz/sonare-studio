/**
 * Loudness/peak report for the engine-backed offline renderer. Measures
 * sample peak directly and derives true-peak/LUFS through the injected
 * metering seam, matching the renderMixdown report shape.
 */

import type { MixdownDeps, MixdownReport } from '@/export/mixdown';
import { peakDb } from '@/lib/db';

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
        report.lufs = metering.interleavedLufs(interleaved, 2, sampleRate);
      } else if (metering.integratedLufs) {
        const mono = new Float32Array(totalFrames);
        for (let i = 0; i < totalFrames; i++) mono[i] = 0.5 * (mixL[i] + mixR[i]);
        report.lufs = metering.integratedLufs(mono, sampleRate);
      }
    } catch {
      // Loudness stays absent when the metering call fails.
    }
  }
  return report;
}
