import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIDI_FX_CONFIG,
  isMidiFxNoop,
  MIDI_FX_CHORD_PRESETS,
  MIDI_FX_QUANTIZE_GRIDS,
  type MidiFxConfig,
  midiFxConfigJson,
  sanitizeChordIntervals,
  sanitizeMidiFxConfig,
} from '@/project/midi-fx';

/** Builds a config from the identity defaults plus overrides. */
function config(overrides: Partial<MidiFxConfig> = {}): MidiFxConfig {
  return sanitizeMidiFxConfig({ ...DEFAULT_MIDI_FX_CONFIG, ...overrides });
}

describe('sanitizeChordIntervals', () => {
  it('clamps, rounds, de-duplicates and caps the voice count', () => {
    expect(sanitizeChordIntervals([0, 4, 7])).toEqual([0, 4, 7]);
    expect(sanitizeChordIntervals([0, 0, 12, 12])).toEqual([0, 12]);
    expect(sanitizeChordIntervals([4.4, -3.6])).toEqual([4, -4]);
    expect(sanitizeChordIntervals([100, -100])).toEqual([48, -48]);
    expect(sanitizeChordIntervals([Number.NaN, 1, Number.POSITIVE_INFINITY])).toEqual([1]);
    expect(sanitizeChordIntervals([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).toHaveLength(8);
  });
});

describe('sanitizeMidiFxConfig', () => {
  it('clamps every field into its supported range', () => {
    const c = sanitizeMidiFxConfig({
      transposeSemitones: 999,
      quantizeStrength: 5,
      quantizeGrid: 100,
      velocityScale: -1,
      velocityOffset: 999,
      velocityGamma: 99,
      humanizeTimingPpq: 9,
      humanizeVelocity: 999,
      chordIntervals: [0, 4],
    });
    expect(c.transposeSemitones).toBe(48);
    expect(c.quantizeStrength).toBe(1);
    expect(c.quantizeGrid).toBe(4);
    expect(c.velocityScale).toBe(0);
    expect(c.velocityOffset).toBe(127);
    expect(c.velocityGamma).toBe(4);
    expect(c.humanizeTimingPpq).toBe(1);
    expect(c.humanizeVelocity).toBe(64);
    expect(c.chordIntervals).toEqual([0, 4]);
  });

  it('falls back to defaults for non-finite numeric fields', () => {
    const c = sanitizeMidiFxConfig({
      transposeSemitones: Number.NaN,
      velocityGamma: Number.POSITIVE_INFINITY,
      quantizeGrid: Number.NaN,
    });
    expect(c.transposeSemitones).toBe(0);
    expect(c.velocityGamma).toBe(1);
    expect(c.quantizeGrid).toBe(DEFAULT_MIDI_FX_CONFIG.quantizeGrid);
  });
});

describe('midiFxConfigJson', () => {
  it('returns null for the identity transform', () => {
    expect(midiFxConfigJson(config())).toBeNull();
    expect(isMidiFxNoop(config())).toBe(true);
  });

  it('emits only the keys that change the notes', () => {
    const json = midiFxConfigJson(config({ transposeSemitones: 12 }));
    expect(json).not.toBeNull();
    expect(JSON.parse(json as string)).toEqual({ transpose_semitones: 12 });
  });

  it('pairs quantize_ppq with quantize_strength only when strength is positive', () => {
    expect(midiFxConfigJson(config({ quantizeStrength: 0, quantizeGrid: 0.5 }))).toBeNull();
    const json = midiFxConfigJson(config({ quantizeStrength: 1, quantizeGrid: 0.5 }));
    expect(JSON.parse(json as string)).toEqual({ quantize_ppq: 0.5, quantize_strength: 1 });
  });

  it('omits a root-only chord but keeps a real harmonization', () => {
    expect(midiFxConfigJson(config({ chordIntervals: [0] }))).toBeNull();
    const json = midiFxConfigJson(config({ chordIntervals: [0, 4, 7] }));
    expect(JSON.parse(json as string)).toEqual({ chord_intervals: [0, 4, 7] });
  });

  it('serializes a combined transform with every effective key', () => {
    const json = midiFxConfigJson(
      config({
        transposeSemitones: -12,
        velocityScale: 1.1,
        velocityOffset: -5,
        velocityGamma: 2,
        humanizeTimingPpq: 0.05,
        humanizeVelocity: 8,
        chordIntervals: [0, 7],
      }),
    );
    expect(JSON.parse(json as string)).toEqual({
      transpose_semitones: -12,
      velocity_scale: 1.1,
      velocity_offset: -5,
      velocity_gamma: 2,
      humanize_ppq: 0.05,
      humanize_velocity: 8,
      chord_intervals: [0, 7],
    });
  });
});

describe('catalogs', () => {
  it('offers an Off harmonize preset and named chords', () => {
    expect(MIDI_FX_CHORD_PRESETS[0]).toMatchObject({ id: 'off', intervals: [] });
    expect(MIDI_FX_CHORD_PRESETS.find((p) => p.id === 'major')?.intervals).toEqual([0, 4, 7]);
  });

  it('offers quantize grids from 1/4 down to 1/32', () => {
    expect(MIDI_FX_QUANTIZE_GRIDS.map((g) => g.id)).toContain('1/4');
    expect(MIDI_FX_QUANTIZE_GRIDS.map((g) => g.id)).toContain('1/32');
    for (const grid of MIDI_FX_QUANTIZE_GRIDS) expect(grid.ppq).toBeGreaterThan(0);
  });
});
