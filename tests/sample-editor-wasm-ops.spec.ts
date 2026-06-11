import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  declickRange,
  denoiseRange,
  loadSampleEditorWasm,
  pitchShiftRange,
  type SampleEditorWasmOps,
  timeStretchRange,
  wasmOpAvailability,
} from '@/ui/sample-editor/wasm-ops';

const { ensureWasmMock } = vi.hoisted(() => ({ ensureWasmMock: vi.fn() }));
vi.mock('@/lib/wasm', () => ({ ensureWasm: ensureWasmMock }));

/** Shorthand: plain number arrays to planar Float32Array channels. */
function ch(...channels: number[][]): Float32Array[] {
  return channels.map((c) => new Float32Array(c));
}

/** Shorthand: planar channels back to plain number arrays. */
function plain(channels: ReadonlyArray<Float32Array>): number[][] {
  return channels.map((c) => [...c]);
}

beforeEach(() => {
  ensureWasmMock.mockReset();
});

describe('wasmOpAvailability', () => {
  it('reports all false for a missing module', () => {
    expect(wasmOpAvailability(null)).toEqual({
      pitchShift: false,
      timeStretch: false,
      declick: false,
      denoise: false,
    });
    expect(wasmOpAvailability(undefined).pitchShift).toBe(false);
  });

  it('reports per-function availability', () => {
    const mod: SampleEditorWasmOps = {
      pitchShift: (samples) => samples,
      masteringRepairDeclick: (samples) => samples,
    };
    expect(wasmOpAvailability(mod)).toEqual({
      pitchShift: true,
      timeStretch: false,
      declick: true,
      denoise: false,
    });
  });
});

describe('loadSampleEditorWasm', () => {
  it('returns the initialized module', async () => {
    const mod = { pitchShift: vi.fn() };
    ensureWasmMock.mockResolvedValue(mod);
    await expect(loadSampleEditorWasm()).resolves.toBe(mod);
  });

  it('returns null when the module fails to initialize', async () => {
    ensureWasmMock.mockRejectedValue(new Error('no wasm here'));
    await expect(loadSampleEditorWasm()).resolves.toBeNull();
  });
});

describe('pitchShiftRange', () => {
  it('delegates per channel over the range and splices the result back', () => {
    const pitchShift = vi.fn(
      (samples: Float32Array, _sampleRate: number, semitones: number) =>
        samples.map((v) => v + semitones) as Float32Array,
    );
    const mod: SampleEditorWasmOps = { pitchShift };
    const input = ch([1, 2, 3, 4], [5, 6, 7, 8]);
    const out = pitchShiftRange(mod, input, 48000, 10, { startFrame: 1, endFrame: 3 });
    expect(plain(out)).toEqual([
      [1, 12, 13, 4],
      [5, 16, 17, 8],
    ]);
    expect(plain(input)).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    expect(pitchShift).toHaveBeenCalledTimes(2);
    expect(pitchShift.mock.calls[0][1]).toBe(48000);
  });

  it('defaults to the whole file without a range', () => {
    const mod: SampleEditorWasmOps = {
      pitchShift: (samples) => samples.map((v) => -v) as Float32Array,
    };
    expect(plain(pitchShiftRange(mod, ch([1, 2]), 48000, 12))).toEqual([[-1, -2]]);
  });

  it('throws when pitchShift is unavailable or input is invalid', () => {
    expect(() => pitchShiftRange({}, ch([1]), 48000, 1)).toThrow(/unavailable/);
    const mod: SampleEditorWasmOps = { pitchShift: (samples) => samples };
    expect(() => pitchShiftRange(mod, ch([1]), 48000, Number.NaN)).toThrow(RangeError);
    expect(() =>
      pitchShiftRange(mod, ch([1, 2]), 48000, 1, { startFrame: 1, endFrame: 1 }),
    ).toThrow(/empty range/);
  });
});

describe('timeStretchRange', () => {
  it('splices a length-changing segment back (total length changes)', () => {
    // Rate 2 halves the duration: keep every other sample.
    const timeStretch = vi.fn(
      (samples: Float32Array, _sampleRate: number, _rate: number) =>
        samples.filter((_, i) => i % 2 === 0) as Float32Array,
    );
    const mod: SampleEditorWasmOps = { timeStretch };
    const out = timeStretchRange(mod, ch([1, 2, 3, 4, 9]), 48000, 2, {
      startFrame: 0,
      endFrame: 4,
    });
    expect(plain(out)).toEqual([[1, 3, 9]]);
  });

  it('trims channels to the shortest segment so output stays planar', () => {
    let call = 0;
    const mod: SampleEditorWasmOps = {
      timeStretch: (samples) => {
        call += 1;
        // Second channel comes back one frame longer than the first.
        return call === 1 ? samples.slice(0, 2) : samples.slice(0, 3);
      },
    };
    const out = timeStretchRange(mod, ch([1, 2, 3, 4], [5, 6, 7, 8]), 48000, 1.5);
    expect(out[0].length).toBe(2);
    expect(out[1].length).toBe(2);
    expect(plain(out)).toEqual([
      [1, 2],
      [5, 6],
    ]);
  });

  it('throws when timeStretch is unavailable or the rate is invalid', () => {
    expect(() => timeStretchRange({}, ch([1]), 48000, 2)).toThrow(/unavailable/);
    const mod: SampleEditorWasmOps = { timeStretch: (samples) => samples };
    expect(() => timeStretchRange(mod, ch([1]), 48000, 0)).toThrow(RangeError);
    expect(() => timeStretchRange(mod, ch([1]), 48000, -1)).toThrow(RangeError);
  });
});

describe('repair operations', () => {
  it('declickRange delegates with the sample rate over the range', () => {
    const masteringRepairDeclick = vi.fn(
      (samples: Float32Array, _sampleRate: number) => samples.map(() => 0.5) as Float32Array,
    );
    const out = declickRange({ masteringRepairDeclick }, ch([1, 2, 3]), 44100, {
      startFrame: 1,
      endFrame: 2,
    });
    expect(plain(out)).toEqual([[1, 0.5, 3]]);
    expect(masteringRepairDeclick).toHaveBeenCalledWith(expect.any(Float32Array), 44100);
  });

  it('denoiseRange delegates per channel', () => {
    const masteringRepairDenoiseClassical = vi.fn(
      (samples: Float32Array) => samples.map((v) => v * 0.5) as Float32Array,
    );
    const out = denoiseRange({ masteringRepairDenoiseClassical }, ch([2, 2], [4, 4]), 48000);
    expect(plain(out)).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it('both throw when the processor is unavailable', () => {
    expect(() => declickRange({}, ch([1]), 48000)).toThrow(/unavailable/);
    expect(() => denoiseRange({}, ch([1]), 48000)).toThrow(/unavailable/);
  });
});
