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

function finiteField(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function parseMonoCompatibility(json: string): MonoCompatibilityReport | null {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof root !== 'object' || root === null) return null;
  const record = root as Record<string, unknown>;
  return {
    correlation: finiteField(record, 'correlation', 0),
    width: finiteField(record, 'monoCompatWidth', 0),
    monoPeakDb: finiteField(record, 'monoCompatPeak', Number.NEGATIVE_INFINITY),
    compatible: record.likelyMonoCompatible === true,
  };
}
