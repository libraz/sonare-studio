import type { EqBand } from '@/wasm/index.js';

const MATCH_POINTS_HZ = [80, 160, 315, 630, 1250, 2500, 5000, 10000] as const;
const MIN_USABLE_DB = -90;
const MIN_GAIN_DB = 1.5;
const MAX_GAIN_DB = 9;

/** Options for deriving a corrective strip EQ from a live spectrum frame. */
export interface MatchFlatEqOptions {
  /** Audio sample rate used by the scope FFT. */
  sampleRate: number;
  /** Maximum number of generated EQ bands. */
  maxBands?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function bandFrequency(index: number, count: number, sampleRate: number): number {
  return ((index + 0.5) / count) * (sampleRate / 2);
}

function octaveDistance(a: number, b: number): number {
  return Math.abs(Math.log2(a / b));
}

function localSpectrumDb(
  bands: ArrayLike<number>,
  sampleRate: number,
  centerHz: number,
): number | null {
  const values: number[] = [];
  for (let index = 0; index < bands.length; index += 1) {
    const value = bands[index];
    if (!Number.isFinite(value) || value < MIN_USABLE_DB) continue;
    const hz = bandFrequency(index, bands.length, sampleRate);
    if (hz <= 0 || octaveDistance(hz, centerHz) > 0.45) continue;
    values.push(value);
  }
  return values.length > 0 ? median(values) : null;
}

/**
 * Derives a small corrective parametric EQ that pulls a live strip spectrum
 * toward its broad-band median. This is a realtime strip helper, not an
 * offline reference-match processor: it only uses the current scope frame.
 */
export function matchFlatEqBands(bands: ArrayLike<number>, options: MatchFlatEqOptions): EqBand[] {
  const sampleRate = options.sampleRate;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || bands.length === 0) return [];
  const nyquist = sampleRate / 2;
  const points = MATCH_POINTS_HZ.flatMap((hz): Array<{ hz: number; db: number }> => {
    if (hz >= nyquist * 0.9) return [];
    const db = localSpectrumDb(bands, sampleRate, hz);
    return db === null ? [] : [{ hz, db }];
  });
  if (points.length < 3) return [];
  const targetDb = median(points.map((point) => point.db));
  const candidates = points
    .map((point) => ({
      hz: point.hz,
      gainDb: clamp(targetDb - point.db, -MAX_GAIN_DB, MAX_GAIN_DB),
    }))
    .filter((point) => Math.abs(point.gainDb) >= MIN_GAIN_DB)
    .sort((a, b) => Math.abs(b.gainDb) - Math.abs(a.gainDb))
    .slice(0, options.maxBands ?? 6)
    .sort((a, b) => a.hz - b.hz);
  return candidates.map((point): EqBand => {
    return {
      type: 'Peak',
      frequencyHz: point.hz,
      gainDb: Number(point.gainDb.toFixed(1)),
      q: 1,
      enabled: true,
    };
  });
}
