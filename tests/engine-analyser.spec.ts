import { describe, expect, it, vi } from 'vitest';
import { createAnalyserBridge } from '@/engine/analyser';
import type { EngineHandle } from '@/engine/engine';

/** Records connect/disconnect targets so taps can be asserted. */
interface FakeNode {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function fakeAnalyser(): {
  fftSize: number;
  frequencyBinCount: number;
  smoothingTimeConstant: number;
  minDecibels: number;
  maxDecibels: number;
  getFloatFrequencyData: ReturnType<typeof vi.fn>;
  getFloatTimeDomainData: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
} {
  return {
    fftSize: 2048,
    get frequencyBinCount() {
      return this.fftSize / 2;
    },
    smoothingTimeConstant: 0,
    minDecibels: -100,
    maxDecibels: 0,
    // Fill with a recognizable value so reads are observable.
    getFloatFrequencyData: vi.fn((out: Float32Array) => out.fill(-42)),
    getFloatTimeDomainData: vi.fn((out: Float32Array) => out.fill(0.25)),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

function makeHandle(options: { withAnalyser?: boolean } = {}): {
  handle: EngineHandle;
  node: FakeNode;
  createAnalyser: ReturnType<typeof vi.fn>;
  createChannelSplitter: ReturnType<typeof vi.fn>;
} {
  const withAnalyser = options.withAnalyser ?? true;
  const node: FakeNode = { connect: vi.fn(), disconnect: vi.fn() };
  const createAnalyser = vi.fn(() => fakeAnalyser());
  const createChannelSplitter = vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  const ctx = {
    sampleRate: 48000,
    createAnalyser: withAnalyser ? createAnalyser : undefined,
    createChannelSplitter: withAnalyser ? createChannelSplitter : undefined,
  };
  const handle = {
    ctx,
    engine: { node },
  } as unknown as EngineHandle;
  return { handle, node, createAnalyser, createChannelSplitter };
}

describe('createAnalyserBridge', () => {
  it('taps the engine output with a spectrum analyser and an L/R scope', () => {
    const { handle, node, createAnalyser, createChannelSplitter } = makeHandle();
    const bridge = createAnalyserBridge(handle, { fftSize: 4096, scopeSize: 2048 });

    expect(bridge.available).toBe(true);
    expect(bridge.sampleRate).toBe(48000);
    expect(bridge.fftSize).toBe(4096);
    expect(bridge.scopeSize).toBe(2048);
    // One spectrum analyser + two scope analysers.
    expect(createAnalyser).toHaveBeenCalledTimes(3);
    expect(createChannelSplitter).toHaveBeenCalledTimes(1);
    // Output node fans out to the spectrum analyser and the splitter.
    expect(node.connect).toHaveBeenCalledTimes(2);
  });

  it('reads spectrum magnitudes into the supplied buffer', () => {
    const { handle } = makeHandle();
    const bridge = createAnalyserBridge(handle, { fftSize: 4096 });
    const out = new Float32Array(bridge.frequencyBinCount);
    expect(bridge.readSpectrum(out)).toBe(true);
    expect(out[0]).toBe(-42);
  });

  it('reads time-domain samples into the L/R buffers', () => {
    const { handle } = makeHandle();
    const bridge = createAnalyserBridge(handle, { scopeSize: 2048 });
    const left = new Float32Array(bridge.scopeSize);
    const right = new Float32Array(bridge.scopeSize);
    expect(bridge.readScope(left, right)).toBe(true);
    expect(left[0]).toBe(0.25);
    expect(right[0]).toBe(0.25);
  });

  it('stops reading and disconnects after dispose', () => {
    const { handle, node } = makeHandle();
    const bridge = createAnalyserBridge(handle);
    bridge.dispose();
    expect(node.disconnect).toHaveBeenCalled();
    expect(bridge.readSpectrum(new Float32Array(bridge.frequencyBinCount))).toBe(false);
    expect(bridge.readScope(new Float32Array(8), new Float32Array(8))).toBe(false);
    // dispose is idempotent.
    expect(() => bridge.dispose()).not.toThrow();
  });

  it('falls back to an unavailable bridge when the context has no analyser', () => {
    const { handle } = makeHandle({ withAnalyser: false });
    const bridge = createAnalyserBridge(handle, { fftSize: 4096, scopeSize: 1024 });
    expect(bridge.available).toBe(false);
    expect(bridge.frequencyBinCount).toBe(2048);
    expect(bridge.readSpectrum(new Float32Array(2048))).toBe(false);
    expect(bridge.readScope(new Float32Array(1024), new Float32Array(1024))).toBe(false);
    expect(() => bridge.dispose()).not.toThrow();
  });
});
