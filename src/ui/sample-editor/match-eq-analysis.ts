/**
 * Parsing for the libsonare reference-pair analyses (`masteringPairAnalyze`),
 * which compare a source against a reference and return JSON strings. Pure data
 * module: it turns those strings into typed results the Match EQ panel renders
 * alongside the applied match. The wasm calls and the audio downmix live in the
 * wasm-ops layer.
 *
 * Three analyses are consumed (see libsonare `named_processor.cpp`):
 * - `match.matchEqCurve`     -> { frequencies: number[], gainDb: number[] }
 * - `match.tonalBalance`     -> { bands: [{ lowHz, highHz, sourceDb,
 *                                referenceDb, deviationDb }] }
 * - `match.referenceLoudness`-> { sourceLufs, referenceLufs, gainToMatchDb }
 */

/** The match EQ correction curve: gain (dB) per frequency (Hz), index-aligned. */
export interface MatchEqCurve {
  /** Frequencies in Hz (ascending), aligned with {@link gainDb}. */
  frequencies: number[];
  /** Correction gain in dB at each frequency. */
  gainDb: number[];
}

/** One tonal-balance band comparing source and reference energy. */
export interface TonalBalanceBand {
  /** Band lower edge in Hz. */
  lowHz: number;
  /** Band upper edge in Hz. */
  highHz: number;
  /** Source energy in this band, in dB. */
  sourceDb: number;
  /** Reference energy in this band, in dB. */
  referenceDb: number;
  /** Source minus reference, in dB (positive = source louder). */
  deviationDb: number;
}

/** Integrated-loudness comparison between source and reference. */
export interface ReferenceLoudness {
  /** Source integrated loudness in LUFS. */
  sourceLufs: number;
  /** Reference integrated loudness in LUFS. */
  referenceLufs: number;
  /** Gain (dB) to apply to the source to match the reference loudness. */
  gainToMatchDb: number;
}

/** The combined Match EQ analysis shown next to the applied match. */
export interface MatchEqAnalysis {
  /** The match EQ correction curve (empty on any problem). */
  curve: MatchEqCurve;
  /** Tonal-balance bands, low to high (empty on any problem). */
  tonalBalance: TonalBalanceBand[];
  /** Loudness comparison, or null when the analysis was unavailable. */
  loudness: ReferenceLoudness | null;
}

/** Reads a finite number from an unknown record field (0 when absent/invalid). */
function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Parses an unknown value into a record, or null when it is not an object. */
function asRecord(root: unknown): Record<string, unknown> | null {
  return typeof root === 'object' && root !== null ? (root as Record<string, unknown>) : null;
}

/** Parses a JSON string into a record, tolerating malformed input. */
function parseRecord(json: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * Parses a `match.matchEqCurve` JSON string. The two arrays are zipped to their
 * common length, dropping any pair where either value is non-finite, so the
 * result is always index-aligned. Malformed input yields empty arrays.
 *
 * @param json The raw string from `masteringPairAnalyze('match.matchEqCurve')`.
 * @returns The parsed curve (empty on any problem).
 */
export function parseMatchEqCurve(json: string): MatchEqCurve {
  const empty: MatchEqCurve = { frequencies: [], gainDb: [] };
  const record = parseRecord(json);
  if (record === null) return empty;
  const frequencies = record.frequencies;
  const gainDb = record.gainDb;
  if (!Array.isArray(frequencies) || !Array.isArray(gainDb)) return empty;
  const count = Math.min(frequencies.length, gainDb.length);
  const curve: MatchEqCurve = { frequencies: [], gainDb: [] };
  for (let i = 0; i < count; i += 1) {
    const frequency = frequencies[i];
    const gain = gainDb[i];
    if (typeof frequency !== 'number' || !Number.isFinite(frequency)) continue;
    if (typeof gain !== 'number' || !Number.isFinite(gain)) continue;
    curve.frequencies.push(frequency);
    curve.gainDb.push(gain);
  }
  return curve;
}

/**
 * Parses a `match.tonalBalance` (or `tonalBalanceLogBands`) JSON string into its
 * bands. Malformed bands are dropped; a non-object or unparseable string yields
 * an empty array.
 *
 * @param json The raw string from `masteringPairAnalyze('match.tonalBalance')`.
 * @returns The parsed bands (empty on any problem).
 */
export function parseTonalBalance(json: string): TonalBalanceBand[] {
  const record = parseRecord(json);
  if (record === null || !Array.isArray(record.bands)) return [];
  const bands: TonalBalanceBand[] = [];
  for (const entry of record.bands) {
    const band = asRecord(entry);
    if (band === null) continue;
    bands.push({
      lowHz: numberField(band, 'lowHz'),
      highHz: numberField(band, 'highHz'),
      sourceDb: numberField(band, 'sourceDb'),
      referenceDb: numberField(band, 'referenceDb'),
      deviationDb: numberField(band, 'deviationDb'),
    });
  }
  return bands;
}

/**
 * Parses a `match.referenceLoudness` JSON string. A non-object or unparseable
 * string yields null.
 *
 * @param json The raw string from `masteringPairAnalyze('match.referenceLoudness')`.
 * @returns The parsed loudness comparison, or null on any problem.
 */
export function parseReferenceLoudness(json: string): ReferenceLoudness | null {
  const record = parseRecord(json);
  if (record === null) return null;
  return {
    sourceLufs: numberField(record, 'sourceLufs'),
    referenceLufs: numberField(record, 'referenceLufs'),
    gainToMatchDb: numberField(record, 'gainToMatchDb'),
  };
}
