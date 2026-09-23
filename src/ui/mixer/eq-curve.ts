/**
 * Channel-EQ magnitude-response math for the strip's mini EQ graph.
 *
 * Bands are evaluated as RBJ audio-EQ-cookbook biquads (the same filter
 * family the wasm StreamingEqualizer implements in its zero-latency mode);
 * the curve is the dB sum of all active bands sampled on a log frequency
 * axis. Band types without a biquad equivalent here (tilt variants) render
 * flat — the graph is a visual aid, not the audible path.
 */

import type { EqBand } from '@/wasm/index.js';

/** One sampled point of the EQ response curve. */
export interface EqCurvePoint {
  /** Frequency in Hz. */
  hz: number;
  /** Response in dB. */
  db: number;
}

/** Default sample rate used to place band frequencies on the digital axis. */
export const EQ_CURVE_SAMPLE_RATE = 48000;

/** Default frequency range of the curve. */
export const EQ_CURVE_MIN_HZ = 20;
export const EQ_CURVE_MAX_HZ = 20000;

/** Normalized biquad coefficients (a0 = 1). */
interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** Computes RBJ cookbook coefficients for one band, or null for flat types. */
function bandCoeffs(band: EqBand, sampleRate: number): BiquadCoeffs | null {
  const type = band.type ?? 'Peak';
  const f0 = Math.min(sampleRate / 2 - 1, Math.max(1, band.frequencyHz ?? 1000));
  const gainDb = band.gainDb ?? 0;
  const q = Math.max(0.01, band.q ?? Math.SQRT1_2);
  const a = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const alpha = sinW / (2 * q);
  // Shelf slope fixed at 1 (the cookbook default).
  const shelfBeta = Math.sqrt(a) / q;

  let b0: number;
  let b1: number;
  let b2: number;
  let a0: number;
  let a1: number;
  let a2: number;
  switch (type) {
    case 'Peak':
      b0 = 1 + alpha * a;
      b1 = -2 * cosW;
      b2 = 1 - alpha * a;
      a0 = 1 + alpha / a;
      a1 = -2 * cosW;
      a2 = 1 - alpha / a;
      break;
    case 'LowShelf':
      b0 = a * (a + 1 - (a - 1) * cosW + shelfBeta * sinW);
      b1 = 2 * a * (a - 1 - (a + 1) * cosW);
      b2 = a * (a + 1 - (a - 1) * cosW - shelfBeta * sinW);
      a0 = a + 1 + (a - 1) * cosW + shelfBeta * sinW;
      a1 = -2 * (a - 1 + (a + 1) * cosW);
      a2 = a + 1 + (a - 1) * cosW - shelfBeta * sinW;
      break;
    case 'HighShelf':
      b0 = a * (a + 1 + (a - 1) * cosW + shelfBeta * sinW);
      b1 = -2 * a * (a - 1 + (a + 1) * cosW);
      b2 = a * (a + 1 + (a - 1) * cosW - shelfBeta * sinW);
      a0 = a + 1 - (a - 1) * cosW + shelfBeta * sinW;
      a1 = 2 * (a - 1 - (a + 1) * cosW);
      a2 = a + 1 - (a - 1) * cosW - shelfBeta * sinW;
      break;
    case 'LowPass':
      b0 = (1 - cosW) / 2;
      b1 = 1 - cosW;
      b2 = (1 - cosW) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosW;
      a2 = 1 - alpha;
      break;
    case 'HighPass':
      b0 = (1 + cosW) / 2;
      b1 = -(1 + cosW);
      b2 = (1 + cosW) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosW;
      a2 = 1 - alpha;
      break;
    case 'BandPass':
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cosW;
      a2 = 1 - alpha;
      break;
    case 'Notch':
      b0 = 1;
      b1 = -2 * cosW;
      b2 = 1;
      a0 = 1 + alpha;
      a1 = -2 * cosW;
      a2 = 1 - alpha;
      break;
    default:
      // AllPass has unit magnitude; TiltShelf / FlatTilt have no single-biquad
      // equivalent. All three draw flat.
      return null;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** True when the band contributes to the response. */
function bandActive(band: EqBand): boolean {
  return band.enabled !== false && band.bypassed !== true;
}

/**
 * Response of one EQ band at a frequency, in dB.
 *
 * @param band Band descriptor (disabled/bypassed bands return 0).
 * @param hz Frequency to evaluate.
 * @param sampleRate Digital axis sample rate.
 */
export function eqBandResponseDb(
  band: EqBand,
  hz: number,
  sampleRate = EQ_CURVE_SAMPLE_RATE,
): number {
  if (!bandActive(band)) return 0;
  const coeffs = bandCoeffs(band, sampleRate);
  if (!coeffs) return 0;
  const w = (2 * Math.PI * Math.max(1, hz)) / sampleRate;
  // Evaluate H(z) at z = e^{jw}.
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);
  const numRe = coeffs.b0 + coeffs.b1 * cos1 + coeffs.b2 * cos2;
  const numIm = -(coeffs.b1 * sin1 + coeffs.b2 * sin2);
  const denRe = 1 + coeffs.a1 * cos1 + coeffs.a2 * cos2;
  const denIm = -(coeffs.a1 * sin1 + coeffs.a2 * sin2);
  const num = numRe * numRe + numIm * numIm;
  const den = denRe * denRe + denIm * denIm;
  if (den <= 0) return 0;
  return 10 * Math.log10(num / den);
}

/**
 * Samples the combined response of an EQ band list on a log frequency axis.
 *
 * @param bands Band descriptors (inactive bands are skipped).
 * @param points Number of samples (default 64).
 * @param minHz Lower bound of the axis.
 * @param maxHz Upper bound of the axis.
 * @param sampleRate Digital axis sample rate.
 */
export function eqCurve(
  bands: ReadonlyArray<EqBand>,
  points = 64,
  minHz = EQ_CURVE_MIN_HZ,
  maxHz = EQ_CURVE_MAX_HZ,
  sampleRate = EQ_CURVE_SAMPLE_RATE,
): EqCurvePoint[] {
  const active = bands.filter(bandActive);
  const ratio = maxHz / minHz;
  const curve: EqCurvePoint[] = [];
  for (let i = 0; i < points; i++) {
    const hz = minHz * ratio ** (i / (points - 1));
    let db = 0;
    for (const band of active) {
      db += eqBandResponseDb(band, hz, sampleRate);
    }
    curve.push({ hz, db });
  }
  return curve;
}

/**
 * Converts a curve into an SVG path string for a width x height viewBox,
 * with 0 dB at the vertical center and +-maxAbsDb at the edges.
 *
 * @param curve Sampled response (must not be empty).
 * @param width ViewBox width in px.
 * @param height ViewBox height in px.
 * @param maxAbsDb dB magnitude mapped to the top/bottom edge.
 */
export function eqCurvePath(
  curve: ReadonlyArray<EqCurvePoint>,
  width: number,
  height: number,
  maxAbsDb = 18,
): string {
  if (curve.length === 0) return '';
  const segments = curve.map((point, i) => {
    const x = (i / (curve.length - 1)) * width;
    const clamped = Math.min(maxAbsDb, Math.max(-maxAbsDb, point.db));
    const y = height / 2 - (clamped / maxAbsDb) * (height / 2);
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  return segments.join(' ');
}
