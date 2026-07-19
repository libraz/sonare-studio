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
export function quantizePcmSample(value: number, positiveMax: number, negativeMax: number): number {
  const clamped = Math.min(1, Math.max(-1, value));
  return Math.round(scalePcmSample(clamped, positiveMax, negativeMax));
}
