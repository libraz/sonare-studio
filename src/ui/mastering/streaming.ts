/**
 * Mapping for the libsonare streaming-target preview
 * (`masteringStreamingPreview`), which measures a master and reports, per
 * streaming platform, how its loudness compares to the platform target. Pure
 * data module: the wasm call and the audio render live in the panel.
 *
 * For each platform the preview returns the measured integrated LUFS and true
 * peak, an optional normalization gain (absent when loudness is unmeasurable)
 * and whether that gain would push the true peak past the platform ceiling.
 * The panel passes explicit platform configs so users are not limited to the
 * wasm build's default list.
 */

import type {
  MasteringStreamingPreviewPlatform,
  MasteringStreamingPreviewResult,
  StreamingPlatform,
} from '@libraz/libsonare';
import type { MixdownReport } from '@/export/mixdown';

/** Editable default target set shown by the mastering panel. */
export const DEFAULT_STREAMING_PLATFORMS: readonly StreamingPlatform[] = [
  { name: 'Spotify', targetLufs: -14, ceilingDbtp: -1 },
  { name: 'Apple Music', targetLufs: -16, ceilingDbtp: -1 },
  { name: 'YouTube', targetLufs: -14, ceilingDbtp: -1 },
  { name: 'Tidal', targetLufs: -14, ceilingDbtp: -1 },
  { name: 'Broadcast', targetLufs: -23, ceilingDbtp: -1 },
];

/** Creates a mutable copy of the editable default streaming targets. */
export function createDefaultStreamingPlatforms(): StreamingPlatform[] {
  return DEFAULT_STREAMING_PLATFORMS.map((platform) => ({ ...platform }));
}

/**
 * Drops malformed platform configs before calling wasm. At least one valid
 * row is required because an empty array would ask libsonare to use its own
 * fixed defaults.
 */
export function normalizeStreamingPlatforms(
  platforms: ReadonlyArray<StreamingPlatform>,
): StreamingPlatform[] {
  return platforms.flatMap((platform) => {
    const normalized = normalizeStreamingPlatform(platform);
    return normalized ? [normalized] : [];
  });
}

/** Counts editor rows that cannot be submitted to the streaming preview. */
export function invalidStreamingPlatformCount(platforms: ReadonlyArray<StreamingPlatform>): number {
  return platforms.filter((platform) => normalizeStreamingPlatform(platform) === null).length;
}

function normalizeStreamingPlatform(platform: StreamingPlatform): StreamingPlatform | null {
  const name = platform.name.trim();
  const targetLufs = Number(platform.targetLufs);
  const ceilingDbtp = Number(platform.ceilingDbtp);
  if (
    name.length === 0 ||
    !Number.isFinite(targetLufs) ||
    !Number.isFinite(ceilingDbtp) ||
    targetLufs > 0 ||
    targetLufs < -80 ||
    ceilingDbtp > 6 ||
    ceilingDbtp < -24
  ) {
    return null;
  }
  return { name, targetLufs, ceilingDbtp };
}

/** One platform's loudness verdict for the analyzed master. */
export type StreamingTarget = MasteringStreamingPreviewPlatform;

/**
 * Computes streaming loudness verdicts from the panel's processed mixdown
 * report. This keeps the table aligned with the same stereo deliverable LUFS
 * and true-peak values shown in the preview pane. A silent LUFS value remains
 * measured as -Infinity, but has no normalization gain. Returns null only when
 * a required measurement is absent, in which case callers may fall back to
 * libsonare's preview seam.
 */
export function streamingTargetsFromReport(
  report: MixdownReport,
  platforms: ReadonlyArray<StreamingPlatform>,
): StreamingTarget[] | null {
  const integratedLufs = report.lufs;
  const truePeakDbtp = report.truePeakDbtp;
  if (
    integratedLufs === undefined ||
    truePeakDbtp === undefined ||
    Number.isNaN(integratedLufs) ||
    Number.isNaN(truePeakDbtp)
  ) {
    return null;
  }
  return platforms.map((platform) => {
    const normalizationGainDb =
      integratedLufs === Number.NEGATIVE_INFINITY
        ? undefined
        : platform.targetLufs - integratedLufs;
    return {
      name: platform.name,
      integratedLufs,
      truePeakDbtp,
      ...(normalizationGainDb === undefined ? {} : { normalizationGainDb }),
      ceilingRisk:
        normalizationGainDb !== undefined &&
        truePeakDbtp + normalizationGainDb > platform.ceilingDbtp,
    };
  });
}

/**
 * Maps the streaming preview result to per-platform targets; entries without
 * a name are dropped.
 *
 * @param result The value returned by `masteringStreamingPreview`.
 * @returns The targets in platform order.
 */
export function streamingTargetsFromPreview(
  result: MasteringStreamingPreviewResult,
): StreamingTarget[] {
  return result.platforms.filter((platform) => platform.name.length > 0);
}
