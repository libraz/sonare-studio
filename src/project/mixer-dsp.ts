/**
 * Offline channel-strip DSP applied to prerendered/loaded clip buffers.
 *
 * The realtime engine node exposes no channel-strip commands, so the honest
 * audible mixer for the current playback path applies strip DSP while
 * scheduling: insert chains and EQ run through the wasm one-shot processors
 * (injected via {@link StripProcessorDeps} so tests can substitute
 * pass-through mocks), and pan is plain balance-law gain math in TS.
 */

import { eqIsActive, type MixerStrip, stripHasDsp } from './mixer';

/** One stereo pair returned by a processor stage. */
export interface StereoBuffers {
  left: Float32Array;
  right: Float32Array;
}

/** Minimal equalizer surface (matches the libsonare StreamingEqualizer). */
export interface StripEqualizer {
  setBand(index: number, band: object): void;
  processStereo(left: Float32Array, right: Float32Array): StereoBuffers;
  delete(): void;
}

/**
 * Injectable wasm processor seam. Production builds this from the wasm
 * module (masteringProcessStereo / StreamingEqualizer); tests pass
 * pass-through-with-marker fakes.
 */
export interface StripProcessorDeps {
  /** One-shot stereo processor invocation (masteringProcessStereo shape). */
  processStereo(
    name: string,
    left: Float32Array,
    right: Float32Array,
    sampleRate: number,
    params: Record<string, number | boolean>,
  ): StereoBuffers;
  /** Equalizer factory; omit to skip EQ processing entirely. */
  createEqualizer?(config: { sampleRate: number; maxBlockSize: number }): StripEqualizer;
}

/** Deep-copies planar channel buffers. */
export function copyChannels(channels: ReadonlyArray<Float32Array>): Float32Array[] {
  return channels.map((channel) => channel.slice());
}

/**
 * Produces a stereo copy of planar buffers: mono input is duplicated onto
 * both sides, stereo (or wider) input keeps its first two channels. The input
 * buffers are never mutated.
 *
 * @param channels Planar buffers (>= 1 channel).
 * @returns Fresh [left, right] copies.
 */
export function toStereo(channels: ReadonlyArray<Float32Array>): [Float32Array, Float32Array] {
  const left = (channels[0] ?? new Float32Array(0)).slice();
  const right = (channels[1] ?? channels[0] ?? new Float32Array(0)).slice();
  return [left, right];
}

/**
 * Applies a stereo balance pan in place: positive pan attenuates the left
 * channel by (1 - pan), negative pan attenuates the right channel by
 * (1 + pan); center is unity on both sides. Mono input is upmixed to a fresh
 * stereo pair first (the mono buffer itself is untouched).
 *
 * @param channels Planar buffers to pan (mutated unless mono).
 * @param pan Balance in [-1, 1] (values outside are clamped).
 * @returns The panned stereo buffers.
 */
export function applyBalancePan(channels: Float32Array[], pan: number): Float32Array[] {
  const clamped = Math.min(1, Math.max(-1, pan));
  const stereo = channels.length >= 2 ? channels : [...toStereo(channels)];
  if (clamped === 0) return stereo;
  const gainL = clamped > 0 ? 1 - clamped : 1;
  const gainR = clamped < 0 ? 1 + clamped : 1;
  const [left, right] = stereo;
  for (let i = 0; i < left.length; i++) left[i] *= gainL;
  for (let i = 0; i < right.length; i++) right[i] *= gainR;
  return stereo;
}

/**
 * Runs a strip's enabled inserts (in order) and its active EQ over planar
 * buffers, returning fresh stereo buffers. The input is never mutated. When
 * the strip carries no DSP — or the buffers are empty — the input is returned
 * unchanged.
 *
 * Strip gain and pan are NOT applied here: gain is folded into the engine
 * per-clip gain and pan is applied per schedule outside the processed-buffer
 * cache (see src/project/scheduling.ts).
 *
 * @param channels Planar input buffers.
 * @param sampleRate Buffer sample rate in Hz.
 * @param strip Strip whose DSP to apply.
 * @param deps Injected wasm processor seam.
 * @returns Processed stereo buffers (or the input when there is nothing to do).
 */
export function applyStripDsp(
  channels: Float32Array[],
  sampleRate: number,
  strip: MixerStrip,
  deps: StripProcessorDeps,
): Float32Array[] {
  if (!stripHasDsp(strip)) return channels;
  const frames = channels[0]?.length ?? 0;
  if (frames === 0) return channels;
  let [left, right] = toStereo(channels);
  for (const slot of strip.inserts) {
    if (!slot.enabled) continue;
    const out = deps.processStereo(slot.processor, left, right, sampleRate, slot.params);
    left = out.left;
    right = out.right;
  }
  if (eqIsActive(strip.eq) && strip.eq && deps.createEqualizer) {
    const eq = deps.createEqualizer({ sampleRate, maxBlockSize: Math.max(1, left.length) });
    try {
      strip.eq.bands.forEach((band, index) => {
        eq.setBand(index, band);
      });
      const out = eq.processStereo(left, right);
      left = out.left;
      right = out.right;
    } finally {
      eq.delete();
    }
  }
  return [left, right];
}
