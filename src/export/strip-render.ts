/**
 * Offline strip rendering for export only: bakes a channel strip's insert/EQ
 * chain into clip buffers for the mixdown renderer (src/export/mixdown.ts).
 *
 * Live playback applies strip DSP in the realtime engine, so these helpers
 * must never re-enter the playback path.
 */

import { ensureWasm } from '@/lib/wasm';
import { type MixerStrip, stripCacheSegment, stripHasDsp } from '@/project/mixer';
import {
  applyBalancePan,
  applyStripDsp,
  copyChannels,
  type StripEqualizer,
  type StripProcessorDeps,
} from '@/project/mixer-dsp';

/**
 * Strip-processed buffers keyed by render identity + strip identity, so
 * re-rendering an unchanged project re-runs no insert/EQ DSP. Pan and gain
 * are excluded from the cache (applied per render).
 */
const processedRenderCache = new Map<string, Float32Array[]>();

/** Clears the strip-processed buffer cache (tests, memory pressure). */
export function clearStripProcessingCache(): void {
  processedRenderCache.clear();
}

/**
 * Builds the strip DSP seam from the loaded wasm module. Returns null when
 * the module exposes no one-shot stereo processor (older builds, minimal test
 * mocks); strips then degrade to gain/pan only.
 */
export async function defaultStripDsp(): Promise<StripProcessorDeps | null> {
  const wasm = (await ensureWasm()) as unknown as {
    masteringProcessStereo?: (
      name: never,
      left: Float32Array,
      right: Float32Array,
      sampleRate?: number,
      params?: Record<string, number | boolean>,
    ) => { left: Float32Array; right: Float32Array };
    StreamingEqualizer?: new (config: {
      sampleRate: number;
      maxBlockSize: number;
    }) => StripEqualizer;
  };
  const processStereo = wasm.masteringProcessStereo;
  if (typeof processStereo !== 'function') return null;
  const deps: StripProcessorDeps = {
    processStereo: (name, left, right, sampleRate, params) => {
      const out = processStereo(name as never, left, right, sampleRate, params);
      return { left: out.left, right: out.right };
    },
  };
  const Equalizer = wasm.StreamingEqualizer;
  if (typeof Equalizer === 'function') {
    deps.createEqualizer = (config) => new Equalizer(config);
  }
  return deps;
}

/**
 * Returns a hook that applies a strip's insert/EQ chain (cached by render +
 * strip identity) and bakes the combined pan into a fresh copy.
 */
export function makeStripProcessor(
  cacheKey: string,
  sampleRate: number,
  strip: MixerStrip | undefined,
  deps: StripProcessorDeps | null,
  pan: number,
): (channels: Float32Array[]) => Float32Array[] {
  return (channels) => {
    let out = channels;
    if (strip && deps && stripHasDsp(strip)) {
      const key = `${cacheKey}|strip=${stripCacheSegment(strip)}`;
      const cached = processedRenderCache.get(key);
      if (cached) {
        out = cached;
      } else {
        out = applyStripDsp(out, sampleRate, strip, deps);
        processedRenderCache.set(key, out);
      }
    }
    // Pan always works on a copy: the cached buffers stay pan-free so one
    // processed render serves every pan position.
    if (pan !== 0) out = applyBalancePan(copyChannels(out), pan);
    return out;
  };
}
