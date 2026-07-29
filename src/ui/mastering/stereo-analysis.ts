/**
 * Parser for libsonare mastering stereo analysis. The panel owns the wasm call;
 * this module keeps the JSON handling deterministic and easy to test.
 */

export interface MonoCompatibilityReport {
  /** Pearson correlation in [-1, 1]. */
  correlation: number;
  /** Side/mid energy ratio, clamped by libsonare. */
  width: number;
  /** Peak of the mono fold-down in dBFS. */
  monoPeakDb: number;
  /** True when the wasm side considers the render mono-compatible. */
  compatible: boolean;
}

function finiteField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseMonoCompatibility(json: string): MonoCompatibilityReport | null {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return null;
  const record = root as Record<string, unknown>;
  const correlation = finiteField(record, 'correlation');
  const width = finiteField(record, 'monoCompatWidth');
  const monoPeakDb = finiteField(record, 'monoCompatPeak');
  if (
    correlation === null ||
    width === null ||
    monoPeakDb === null ||
    typeof record.likelyMonoCompatible !== 'boolean'
  ) {
    return null;
  }
  return {
    correlation,
    width,
    monoPeakDb,
    compatible: record.likelyMonoCompatible,
  };
}
