/**
 * Parsing for the libsonare streaming-target preview
 * (`masteringStreamingPreview`), which measures a master and reports, per
 * streaming platform, how its loudness compares to the platform target. Pure
 * data module: the wasm call and the audio render live in the panel.
 *
 * For each platform the preview returns the measured integrated LUFS and true
 * peak, the normalization gain the platform would apply (target − measured;
 * positive = turned up, negative = turned down) and whether that gain would
 * push the true peak past the platform ceiling. With no platforms passed the
 * wasm side uses its own defaults (Spotify, Apple Music, YouTube).
 */

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
