import { describe, expect, it, vi } from 'vitest';
import {
  clampPan,
  createDefaultStrip,
  dbToLinear,
  eqIsActive,
  isDefaultStrip,
  type MixerStrip,
  stripCacheSegment,
  stripHasDsp,
} from '@/project/mixer';
import {
  applyBalancePan,
  applyStripDsp,
  copyChannels,
  type StripProcessorDeps,
  toStereo,
} from '@/project/mixer-dsp';

/** Builds a strip with overridable fields. */
function makeStrip(overrides: Partial<MixerStrip> = {}): MixerStrip {
  return { ...createDefaultStrip(), ...overrides };
}

/**
 * Pass-through-with-marker processor deps: every insert invocation adds a
 * constant offset to all samples, so order and enabled filtering are
 * observable in the output values.
 */
function markerDeps(offset = 0.1): StripProcessorDeps & {
  calls: Array<{ name: string; params: Record<string, number | boolean>; sampleRate: number }>;
} {
  const calls: Array<{
    name: string;
    params: Record<string, number | boolean>;
    sampleRate: number;
  }> = [];
  return {
    calls,
    processStereo(name, left, right, sampleRate, params) {
      calls.push({ name, params, sampleRate });
      return {
        left: left.map((x) => x + offset),
        right: right.map((x) => x + offset),
      };
    },
  };
}

describe('dbToLinear / clampPan', () => {
  it('converts decibels to linear amplitude', () => {
    expect(dbToLinear(0)).toBe(1);
    expect(dbToLinear(-6)).toBeCloseTo(0.5012, 3);
    expect(dbToLinear(6)).toBeCloseTo(1.9953, 3);
    expect(dbToLinear(-20)).toBeCloseTo(0.1, 10);
  });

  it('clamps pan to [-1, 1]', () => {
    expect(clampPan(0.4)).toBe(0.4);
    expect(clampPan(1.5)).toBe(1);
    expect(clampPan(-2)).toBe(-1);
  });
});

describe('toStereo / copyChannels', () => {
  it('duplicates mono onto both sides without mutating the input', () => {
    const mono = new Float32Array([1, 2]);
    const [left, right] = toStereo([mono]);
    expect(Array.from(left)).toEqual([1, 2]);
    expect(Array.from(right)).toEqual([1, 2]);
    expect(left).not.toBe(mono);
    expect(right).not.toBe(mono);
  });

  it('keeps the first two channels of wider input as copies', () => {
    const channels = [new Float32Array([1]), new Float32Array([2]), new Float32Array([3])];
    const [left, right] = toStereo(channels);
    expect(Array.from(left)).toEqual([1]);
    expect(Array.from(right)).toEqual([2]);
  });

  it('copyChannels yields independent buffers', () => {
    const channels = [new Float32Array([1, 2])];
    const copy = copyChannels(channels);
    copy[0][0] = 9;
    expect(channels[0][0]).toBe(1);
  });
});

describe('applyBalancePan', () => {
  it('attenuates the left channel for positive pan', () => {
    const out = applyBalancePan([new Float32Array([1, 1]), new Float32Array([1, 1])], 0.25);
    expect(Array.from(out[0])).toEqual([0.75, 0.75]);
    expect(Array.from(out[1])).toEqual([1, 1]);
  });

  it('attenuates the right channel for negative pan', () => {
    const out = applyBalancePan([new Float32Array([0.5]), new Float32Array([0.5])], -0.5);
    expect(out[0][0]).toBeCloseTo(0.5, 6);
    expect(out[1][0]).toBeCloseTo(0.25, 6);
  });

  it('is a unity passthrough at center', () => {
    const left = new Float32Array([0.3]);
    const right = new Float32Array([0.4]);
    const out = applyBalancePan([left, right], 0);
    expect(out[0][0]).toBeCloseTo(0.3, 6);
    expect(out[1][0]).toBeCloseTo(0.4, 6);
  });

  it('upmixes mono to stereo before panning (input untouched)', () => {
    const mono = new Float32Array([1]);
    const out = applyBalancePan([mono], 1);
    expect(out).toHaveLength(2);
    expect(out[0][0]).toBe(0); // hard right: left fully attenuated
    expect(out[1][0]).toBe(1);
    expect(mono[0]).toBe(1);
  });

  it('clamps out-of-range pan', () => {
    const out = applyBalancePan([new Float32Array([1]), new Float32Array([1])], 4);
    expect(out[0][0]).toBe(0);
    expect(out[1][0]).toBe(1);
  });
});

describe('stripHasDsp / stripCacheSegment / isDefaultStrip', () => {
  it('a neutral strip has no DSP and segment "none"', () => {
    expect(stripHasDsp(undefined)).toBe(false);
    expect(stripHasDsp(makeStrip())).toBe(false);
    expect(stripCacheSegment(makeStrip())).toBe('none');
    expect(isDefaultStrip(makeStrip())).toBe(true);
  });

  it('gain and pan alone are not buffer DSP', () => {
    const strip = makeStrip({ gainDb: -6, pan: 0.5 });
    expect(stripHasDsp(strip)).toBe(false);
    expect(isDefaultStrip(strip)).toBe(false);
  });

  it('enabled inserts and active EQ count as DSP', () => {
    const insert = makeStrip({
      inserts: [{ processor: 'eq.tilt', params: {}, enabled: true }],
    });
    expect(stripHasDsp(insert)).toBe(true);
    const bypassed = makeStrip({
      inserts: [{ processor: 'eq.tilt', params: {}, enabled: false }],
    });
    expect(stripHasDsp(bypassed)).toBe(false);
    const eq = makeStrip({ eq: { enabled: true, bands: [{ type: 'Peak', gainDb: 3 }] } });
    expect(stripHasDsp(eq)).toBe(true);
    const eqOff = makeStrip({ eq: { enabled: false, bands: [{ type: 'Peak', gainDb: 3 }] } });
    expect(stripHasDsp(eqOff)).toBe(false);
    expect(eqIsActive(eqOff.eq)).toBe(false);
  });

  it('segment identity covers insert params and order, not gain/pan', () => {
    const a = makeStrip({
      gainDb: -3,
      inserts: [{ processor: 'dynamics.compressor', params: { ratio: 2 }, enabled: true }],
    });
    const b = makeStrip({
      gainDb: 6,
      pan: 1,
      inserts: [{ processor: 'dynamics.compressor', params: { ratio: 2 }, enabled: true }],
    });
    expect(stripCacheSegment(a)).toBe(stripCacheSegment(b));

    const changedParam = makeStrip({
      inserts: [{ processor: 'dynamics.compressor', params: { ratio: 4 }, enabled: true }],
    });
    expect(stripCacheSegment(changedParam)).not.toBe(stripCacheSegment(a));

    const twoInserts = (first: string, second: string): MixerStrip =>
      makeStrip({
        inserts: [
          { processor: first, params: {}, enabled: true },
          { processor: second, params: {}, enabled: true },
        ],
      });
    expect(stripCacheSegment(twoInserts('eq.tilt', 'saturation.tape'))).not.toBe(
      stripCacheSegment(twoInserts('saturation.tape', 'eq.tilt')),
    );
  });
});

describe('applyStripDsp', () => {
  const input = [new Float32Array([0.1, 0.2]), new Float32Array([0.3, 0.4])];

  it('returns the input untouched when the strip has no DSP', () => {
    const deps = markerDeps();
    const out = applyStripDsp(input, 48000, makeStrip({ gainDb: -6 }), deps);
    expect(out).toBe(input);
    expect(deps.calls).toEqual([]);
  });

  it('runs enabled inserts in order with their params, skipping bypassed ones', () => {
    const deps = markerDeps(0.1);
    const strip = makeStrip({
      inserts: [
        { processor: 'eq.tilt', params: { tiltDb: 2 }, enabled: true },
        { processor: 'dynamics.compressor', params: { ratio: 3 }, enabled: false },
        { processor: 'saturation.tape', params: {}, enabled: true },
      ],
    });
    const out = applyStripDsp(input, 44100, strip, deps);
    expect(deps.calls.map((c) => c.name)).toEqual(['eq.tilt', 'saturation.tape']);
    expect(deps.calls[0].params).toEqual({ tiltDb: 2 });
    expect(deps.calls[0].sampleRate).toBe(44100);
    // Two enabled inserts, each adding the 0.1 marker.
    expect(out[0][0]).toBeCloseTo(0.3, 6);
    expect(out[1][1]).toBeCloseTo(0.6, 6);
    // The input buffers are untouched.
    expect(input[0][0]).toBeCloseTo(0.1, 6);
  });

  it('upmixes mono input through the chain', () => {
    const deps = markerDeps(0.5);
    const strip = makeStrip({
      inserts: [{ processor: 'eq.tilt', params: {}, enabled: true }],
    });
    const out = applyStripDsp([new Float32Array([0.2])], 48000, strip, deps);
    expect(out).toHaveLength(2);
    expect(out[0][0]).toBeCloseTo(0.7, 6);
    expect(out[1][0]).toBeCloseTo(0.7, 6);
  });

  it('runs the EQ before the inserts (pre-insert strip topology)', () => {
    const stages: string[] = [];
    const deps: StripProcessorDeps = {
      processStereo: (_name, left, right) => {
        stages.push('insert');
        return { left: left.map((x) => x + 0.1), right: right.map((x) => x + 0.1) };
      },
      createEqualizer: () => ({
        setBand: () => {},
        processStereo: (left: Float32Array, right: Float32Array) => {
          stages.push('eq');
          return { left: left.map((x) => x * 2), right: right.map((x) => x * 2) };
        },
        delete: () => {},
      }),
    };
    const strip = makeStrip({
      inserts: [{ processor: 'eq.tilt', params: {}, enabled: true }],
      eq: { enabled: true, bands: [{ type: 'Peak', gainDb: 3 }] },
    });
    const out = applyStripDsp(input, 48000, strip, deps);
    expect(stages).toEqual(['eq', 'insert']);
    // EQ doubles 0.1 to 0.2, then the insert adds 0.1 (insert-first would
    // yield 0.4 instead).
    expect(out[0][0]).toBeCloseTo(0.3, 6);
  });

  it('applies the active EQ through the injected equalizer', () => {
    const setBand = vi.fn();
    const del = vi.fn();
    const deps: StripProcessorDeps = {
      processStereo: (_n, left, right) => ({ left, right }),
      createEqualizer: vi.fn(() => ({
        setBand,
        processStereo: (left: Float32Array, right: Float32Array) => ({
          left: left.map((x) => x * 2),
          right: right.map((x) => x * 2),
        }),
        delete: del,
      })),
    };
    const strip = makeStrip({
      eq: {
        enabled: true,
        bands: [
          { type: 'Peak', frequencyHz: 500, gainDb: 3 },
          { type: 'HighShelf', frequencyHz: 8000, gainDb: -2 },
        ],
      },
    });
    const out = applyStripDsp(input, 48000, strip, deps);
    expect(deps.createEqualizer).toHaveBeenCalledWith({ sampleRate: 48000, maxBlockSize: 2 });
    expect(setBand).toHaveBeenCalledTimes(2);
    expect(setBand.mock.calls[0][0]).toBe(0);
    expect(out[0][0]).toBeCloseTo(0.2, 6);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('skips EQ when no equalizer factory is provided', () => {
    const deps = markerDeps();
    const strip = makeStrip({
      eq: { enabled: true, bands: [{ type: 'Peak', gainDb: 3 }] },
    });
    const out = applyStripDsp(input, 48000, strip, deps);
    // No inserts and no factory: a stereo copy passes through unchanged.
    expect(Array.from(out[0])).toEqual(Array.from(input[0]));
    expect(out[0]).not.toBe(input[0]);
  });

  it('returns empty buffers untouched', () => {
    const deps = markerDeps();
    const strip = makeStrip({
      inserts: [{ processor: 'eq.tilt', params: {}, enabled: true }],
    });
    const empty = [new Float32Array(0), new Float32Array(0)];
    expect(applyStripDsp(empty, 48000, strip, deps)).toBe(empty);
    expect(deps.calls).toEqual([]);
  });
});
