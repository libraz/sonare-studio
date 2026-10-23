/**
 * Shared signed-PCM quantization used by every integer codec (WAV, FLAC, MP3).
 *
 * Signed PCM is asymmetric: an N-bit sample spans [-2^(N-1), 2^(N-1)-1], so the
 * negative full scale (-1.0) maps to -2^(N-1) and the positive full scale
 * (+1.0) to 2^(N-1)-1. Scaling both signs by the positive maximum would leave
 * the most-negative code unused and make the codecs disagree on identical
 * input; keeping this in one place guarantees they quantize the same way.
 */

/**
 * Scales a sample already clamped to [-1, 1] onto the signed-PCM range without
 * rounding, so callers that add dither can do so before quantizing.
 *
 * @param clamped Sample in [-1, 1].
 * @param positiveMax Positive full-scale code (e.g. 0x7fff for 16-bit).
 * @param negativeMax Magnitude of the negative full-scale code (e.g. 0x8000).
 * @returns The scaled float value.
 */
export function scalePcmSample(clamped: number, positiveMax: number, negativeMax: number): number {
  return clamped < 0 ? clamped * negativeMax : clamped * positiveMax;
}

/**
 * Clamps a float sample to [-1, 1] and quantizes it to a signed integer using
 * the asymmetric signed-PCM mapping.
 *
 * @param value Raw float sample (over-range values are hard-clipped).
 * @param positiveMax Positive full-scale code (e.g. 0x7fff for 16-bit).
 * @param negativeMax Magnitude of the negative full-scale code (e.g. 0x8000).
 * @returns The quantized signed integer sample.
 */
export function quantizePcmSample(
  value: number,
  positiveMax: number,
  negativeMax: number,
  ditherLsb = 0,
): number {
  // `Math.min/max` preserves NaN, which becomes an invalid BigInt in FLAC.
  // Treat malformed source samples as silence consistently in every integer
  // codec before scaling or adding optional dither.
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(-1, value)) : 0;
  const quantized = Math.round(scalePcmSample(clamped, positiveMax, negativeMax) + ditherLsb);
  return Math.min(positiveMax, Math.max(-negativeMax, quantized));
}

function ditherUnit(index: number, salt: number): number {
  let value = (index + salt) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0x100000000;
}

/**
 * Stateless TPDF dither in LSBs keyed by absolute frame and channel, so every
 * codec and every chunking of one render draws the same noise.
 *
 * @param frame Absolute frame index within the rendered signal.
 * @param channel Channel index.
 * @returns A value in (-1, 1) LSB with triangular distribution.
 */
export function tpdfDitherLsb(frame: number, channel: number): number {
  const index = frame * 31 + channel;
  return ditherUnit(index, 0x9e3779b9) - ditherUnit(index, 0x85ebca6b);
}
