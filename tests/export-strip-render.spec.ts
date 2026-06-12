import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearStripProcessingCache,
  defaultStripDsp,
  makeStripProcessor,
} from '@/export/strip-render';
import { createDefaultStrip, type MixerStrip } from '@/project/mixer';
import type { StripProcessorDeps } from '@/project/mixer-dsp';

/** The module ensureWasm resolves to; swapped per test. */
let wasmModule: object = {};

vi.mock('@/lib/wasm', () => ({ ensureWasm: async () => wasmModule }));

/** A strip with one enabled marker insert. */
function dspStrip(overrides: Partial<MixerStrip> = {}): MixerStrip {
  return {
    ...createDefaultStrip(),
    inserts: [{ processor: 'eq.tilt', params: { tiltDb: 2 }, enabled: true }],
    ...overrides,
  };
}

/** Pass-through-with-marker deps adding +0.25 per insert run. */
function markerDeps(): StripProcessorDeps & { processStereo: ReturnType<typeof vi.fn> } {
  return {
    processStereo: vi.fn((_name: string, left: Float32Array, right: Float32Array) => ({
      left: left.map((x) => x + 0.25),
      right: right.map((x) => x + 0.25),
    })),
  };
}

describe('makeStripProcessor', () => {
  beforeEach(() => {
    clearStripProcessingCache();
  });

  it('applies the insert chain and caches by render + strip identity', async () => {
    const deps = markerDeps();
    const process = makeStripProcessor('render-key', 48000, dspStrip(), deps, 0);
    const render = [new Float32Array([0.5]), new Float32Array([0.5])];
    const first = process(render);
    const second = process(render);
    expect(deps.processStereo).toHaveBeenCalledTimes(1);
    expect(first[0][0]).toBeCloseTo(0.75, 6);
    expect(second).toBe(first);
    // The raw render is never mutated (the cache feeds the renderer copies).
    expect(render[0][0]).toBeCloseTo(0.5, 6);
  });

  it('keeps cached buffers pan-free and bakes pan into a fresh copy', async () => {
    const deps = markerDeps();
    const strip = dspStrip();
    const render = [new Float32Array([0.5]), new Float32Array([0.5])];
    const panned = makeStripProcessor('render-key', 48000, strip, deps, 0.5)(render);
    // Positive pan attenuates the left channel after the insert marker.
    expect(panned[0][0]).toBeCloseTo(0.375, 6);
    expect(panned[1][0]).toBeCloseTo(0.75, 6);
    // The same render + strip identity still serves a pan-free schedule.
    const centered = makeStripProcessor('render-key', 48000, strip, deps, 0)(render);
    expect(deps.processStereo).toHaveBeenCalledTimes(1);
    expect(centered[0][0]).toBeCloseTo(0.75, 6);
    expect(centered[1][0]).toBeCloseTo(0.75, 6);
  });

  it('passes DSP-less input through (pan only) without touching the cache', async () => {
    const render = [new Float32Array([0.5]), new Float32Array([0.5])];
    const passThrough = makeStripProcessor('render-key', 48000, createDefaultStrip(), null, 0);
    expect(passThrough(render)).toBe(render);
    const panned = makeStripProcessor('render-key', 48000, createDefaultStrip(), null, -0.5);
    const out = panned(render);
    expect(out[0][0]).toBeCloseTo(0.5, 6);
    expect(out[1][0]).toBeCloseTo(0.25, 6);
    expect(render[1][0]).toBeCloseTo(0.5, 6);
  });

  it('clearStripProcessingCache forces the DSP to re-run', async () => {
    const deps = markerDeps();
    const process = makeStripProcessor('render-key', 48000, dspStrip(), deps, 0);
    const render = [new Float32Array([0.5]), new Float32Array([0.5])];
    process(render);
    clearStripProcessingCache();
    process(render);
    expect(deps.processStereo).toHaveBeenCalledTimes(2);
  });
});

describe('defaultStripDsp', () => {
  it('builds the seam from a wasm module exposing the one-shot processor', async () => {
    const { createFakeWasmModule } = await import('./fake-wasm');
    wasmModule = createFakeWasmModule();
    const deps = await defaultStripDsp();
    expect(deps).not.toBeNull();
    expect(deps?.processStereo).toBeTypeOf('function');
    expect(deps?.createEqualizer).toBeTypeOf('function');
  });

  it('returns null when the module exposes no one-shot stereo processor', async () => {
    wasmModule = {};
    expect(await defaultStripDsp()).toBeNull();
  });
});
