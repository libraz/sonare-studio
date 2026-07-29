/**
 * Parsing for the libsonare streaming-target preview
 * (`masteringStreamingPreview`), which measures a master and reports, per
 * streaming platform, how its loudness compares to the platform target. Pure
 * data module: the wasm call and the audio render live in the panel.
 *
 * For each platform the preview returns the measured integrated LUFS and true
 * peak, the normalization gain the platform would apply (target − measured;
 * positive = turned up, negative = turned down) and whether that gain would
 * push the true peak past the platform ceiling. The panel passes explicit
 * platform configs so users are not limited to the wasm build's default list.
 */

import type { MixdownReport } from '@/export/mixdown';
import type { StreamingPlatform } from '@/wasm/index.js';

/** App-level streaming target config, matching libsonare's preview ABI. */
export type StreamingPlatformConfig = StreamingPlatform;

/** Editable default target set shown by the mastering panel. */
export const DEFAULT_STREAMING_PLATFORMS: readonly StreamingPlatformConfig[] = [
  { name: 'Spotify', targetLufs: -14, ceilingDb: -1 },
  { name: 'Apple Music', targetLufs: -16, ceilingDb: -1 },
  { name: 'YouTube', targetLufs: -14, ceilingDb: -1 },
  { name: 'Tidal', targetLufs: -14, ceilingDb: -1 },
  { name: 'Broadcast', targetLufs: -23, ceilingDb: -1 },
];

/** Creates a mutable copy of the editable default streaming targets. */
export function createDefaultStreamingPlatforms(): StreamingPlatformConfig[] {
  return DEFAULT_STREAMING_PLATFORMS.map((platform) => ({ ...platform }));
}

/**
 * Drops malformed platform configs before calling wasm. At least one valid
 * row is required because an empty array would ask libsonare to use its own
 * fixed defaults.
 */
export function normalizeStreamingPlatforms(
  platforms: ReadonlyArray<StreamingPlatformConfig>,
): StreamingPlatformConfig[] {
  return platforms.flatMap((platform) => {
    const normalized = normalizeStreamingPlatform(platform);
    return normalized ? [normalized] : [];
  });
}

/** Counts editor rows that cannot be submitted to the streaming preview. */
export function invalidStreamingPlatformCount(
  platforms: ReadonlyArray<StreamingPlatformConfig>,
): number {
  return platforms.filter((platform) => normalizeStreamingPlatform(platform) === null).length;
}

function normalizeStreamingPlatform(
  platform: StreamingPlatformConfig,
): StreamingPlatformConfig | null {
  const name = platform.name.trim();
  const targetLufs = Number(platform.targetLufs);
  const ceilingDb = Number(platform.ceilingDb);
  if (
    name.length === 0 ||
    !Number.isFinite(targetLufs) ||
    !Number.isFinite(ceilingDb) ||
    targetLufs > 0 ||
    targetLufs < -80 ||
    ceilingDb > 6 ||
    ceilingDb < -24
  ) {
    return null;
  }
  return { name, targetLufs, ceilingDb };
}

/** One platform's loudness verdict for the analyzed master. */
export interface StreamingTarget {
  /** Platform name as reported by the wasm side (e.g. 'Spotify'). */
  name: string;
  /** Measured integrated loudness of the master, in LUFS. */
  integratedLufs: number;
  /** Measured true peak of the master, in dBTP. */
  truePeakDb: number;
  /** Gain the platform applies to hit its target (target − measured), in dB. */
  normalizationGainDb: number;
  /** True when the normalized true peak would exceed the platform ceiling. */
  ceilingRisk: boolean;
}

/**
 * Computes streaming loudness verdicts from the panel's processed mixdown
 * report. This keeps the table aligned with the same stereo deliverable LUFS
 * and true-peak values shown in the preview pane. Returns null when the report
 * lacks the required metering fields, in which case callers may fall back to
 * libsonare's mono preview seam.
 */
export function streamingTargetsFromReport(
  report: MixdownReport,
  platforms: ReadonlyArray<StreamingPlatformConfig>,
): StreamingTarget[] | null {
  const integratedLufs = report.lufs;
  const truePeakDb = report.truePeakDb ?? report.peakDb;
  if (
    typeof integratedLufs !== 'number' ||
    !Number.isFinite(integratedLufs) ||
    !Number.isFinite(truePeakDb)
  ) {
    return null;
  }
  return platforms.map((platform) => {
    const normalizationGainDb = platform.targetLufs - integratedLufs;
    return {
      name: platform.name,
      integratedLufs,
      truePeakDb,
      normalizationGainDb,
      ceilingRisk: truePeakDb + normalizationGainDb > platform.ceilingDb,
    };
  });
}

/** Reads a finite number from an unknown record field (0 when absent/invalid). */
function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Parses the streaming preview's JSON string into per-platform targets.
 * Malformed input, missing fields and wrong types are tolerated: a non-object
 * or unparseable string yields an empty list rather than throwing, and entries
 * without a name are dropped.
 *
 * @param json The raw string returned by `masteringStreamingPreview`.
 * @returns The parsed targets (empty on any problem).
 */
export function parseStreamingPreview(json: string): StreamingTarget[] {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof root !== 'object' || root === null) return [];
  const platforms = (root as Record<string, unknown>).platforms;
  if (!Array.isArray(platforms)) return [];

  const targets: StreamingTarget[] = [];
  for (const entry of platforms) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== 'string' || record.name.length === 0) continue;
    targets.push({
      name: record.name,
      integratedLufs: numberField(record, 'integratedLufs'),
      truePeakDb: numberField(record, 'truePeakDb'),
      normalizationGainDb: numberField(record, 'normalizationGainDb'),
      ceilingRisk: record.ceilingRisk === true,
    });
  }
  return targets;
}
