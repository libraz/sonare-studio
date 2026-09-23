import { describe, expect, it, vi } from 'vitest';
import {
  adsrEnvelopePoints,
  clampPatchField,
  createModMatrixRow,
  createPatchDraft,
  MAX_MOD_ROUTINGS,
  modMatrixRows,
  modRowsToRoutings,
  PATCH_FIELD_SPECS,
  patchEditCount,
  patchFieldSpec,
  patchFieldsForSection,
  sanitizePatchDraft,
} from '@/ui/devices/patch-draft';
import { FALLBACK_SYNTH_ENUMS, resolveSynthEnums } from '@/ui/devices/synth-enums';
import {
  ARTICULATIONS,
  CONTROLLER_AXES,
  CONTROLLER_INPUTS,
  MPE_DIMENSIONS,
  NOTE_TRACKINGS,
  SYNTH_BODY_TYPES,
  SYNTH_ENGINE_MODES,
  SYNTH_FILTER_MODELS,
  SYNTH_FILTER_OUTPUTS,
  SYNTH_MOD_DESTINATIONS,
  SYNTH_MOD_SOURCES,
  SYNTH_OSC_WAVEFORMS,
  type SynthPatch,
} from '@/wasm/index.js';

describe('patchFieldsForSection', () => {
  it('partitions every spec into exactly one section', () => {
    const sections = ['osc', 'filter', 'amp', 'filter-env', 'lfo', 'global'] as const;
    const total = sections.reduce((sum, section) => sum + patchFieldsForSection(section).length, 0);
    expect(total).toBe(PATCH_FIELD_SPECS.length);
  });

  it('keeps the four amp envelope fields together', () => {
    expect(patchFieldsForSection('amp').map((spec) => spec.id)).toEqual([
      'ampAttackMs',
      'ampDecayMs',
      'ampSustain',
      'ampReleaseMs',
    ]);
  });

  it('exposes LFO2 and shared deep wrapper parameters', () => {
    expect(patchFieldsForSection('lfo').map((spec) => spec.id)).toEqual([
      'lfoRateHz',
      'lfoToPitchCents',
      'lfo2RateHz',
    ]);
    expect(patchFieldsForSection('global').map((spec) => spec.id)).toEqual([
      'glideMs',
      'bodyMix',
      'gain',
      'polyphony',
      'busDrive',
    ]);
  });

  it('keeps a stable i18n key for every numeric field', () => {
    expect(PATCH_FIELD_SPECS.every((spec) => spec.labelKey === spec.id)).toBe(true);
  });
});

describe('clampPatchField', () => {
  it('clamps non-zero values into the spec range', () => {
    expect(clampPatchField('cutoffHz', 99999)).toBe(20000);
    expect(clampPatchField('cutoffHz', 1)).toBe(20);
    expect(clampPatchField('ampSustain', 1.5)).toBe(1);
  });

  it('lifts zero into the range of fields that exclude it', () => {
    expect(clampPatchField('cutoffHz', 0)).toBe(20);
    expect(clampPatchField('unison', 0)).toBe(1);
  });

  it('keeps zero verbatim as an explicit override', () => {
    expect(clampPatchField('ampSustain', 0)).toBe(0);
    expect(clampPatchField('filterSustain', 0)).toBe(0);
    expect(clampPatchField('glideMs', 0)).toBe(0);
  });

  it('rounds integer fields and degrades non-finite input into range', () => {
    expect(clampPatchField('unison', 3.6)).toBe(4);
    expect(clampPatchField('polyphony', 200)).toBe(64);
    expect(clampPatchField('gain', Number.NaN)).toBe(0);
    expect(clampPatchField('cutoffHz', Number.NaN)).toBe(20);
  });
});

describe('mod matrix rows', () => {
  it('round-trips string routings', () => {
    const patch: SynthPatch = {
      modRoutings: [{ source: 'lfo1', destination: 'pitch-cents', depth: 0.5 }],
    };
    const rows = modMatrixRows(patch);
    expect(rows).toEqual([{ source: 'lfo1', destination: 'pitch-cents', depth: 0.5 }]);
    expect(modRowsToRoutings(rows)).toEqual(patch.modRoutings);
  });

  it('resolves numeric enum ordinals to names', () => {
    const rows = modMatrixRows({ modRoutings: [{ source: 3, destination: 2, depth: 0.25 }] });
    expect(rows).toEqual([{ source: 'lfo1', destination: 'cutoff-cents', depth: 0.25 }]);
  });

  it('drops inert rows and clamps depth', () => {
    const routings = modRowsToRoutings([
      createModMatrixRow(),
      { source: 'lfo1', destination: 'none', depth: 1 },
      { source: 'none', destination: 'amp-gain', depth: 1 },
      { source: 'velocity', destination: 'amp-gain', depth: 0 },
      { source: 'lfo2', destination: 'pan-units', depth: 4 },
    ]);
    expect(routings).toEqual([{ source: 'lfo2', destination: 'pan-units', depth: 1 }]);
  });

  it('caps the routing list at the ABI maximum', () => {
    const rows = Array.from({ length: 12 }, () => ({
      source: 'lfo1',
      destination: 'pitch-cents',
      depth: 0.1,
    }));
    expect(modRowsToRoutings(rows)).toHaveLength(MAX_MOD_ROUTINGS);
  });
});

describe('createPatchDraft', () => {
  it('seeds a preset instrument with the resolved base values', () => {
    const resolve = vi.fn(() => ({ cutoffHz: 12000, ampSustain: 0.6, waveform: 'saw' }));
    const draft = createPatchDraft({ kind: 'synth-preset', preset: 'saw-lead' }, resolve);
    expect(resolve).toHaveBeenCalledWith('saw-lead');
    expect(draft).toMatchObject({
      preset: 'saw-lead',
      cutoffHz: 12000,
      ampSustain: 0.6,
      waveform: 'saw',
    });
  });

  it('layers explicit patch fields over the preset base', () => {
    const resolve = vi.fn(() => ({ cutoffHz: 12000, drive: 0.3 }));
    const draft = createPatchDraft(
      { kind: 'synth-patch', patch: { preset: 'saw-lead', cutoffHz: 440 } },
      resolve,
    );
    expect(draft.cutoffHz).toBe(440);
    expect(draft.drive).toBe(0.3);
    expect(draft.preset).toBe('saw-lead');
  });

  it('starts from an init patch for sf2/missing instruments and resolver failures', () => {
    expect(createPatchDraft({ kind: 'sf2', fontId: 'gm' })).toEqual({});
    expect(createPatchDraft(null)).toEqual({});
    const throwing = vi.fn(() => {
      throw new Error('no catalog');
    });
    expect(createPatchDraft({ kind: 'synth-preset', preset: 'pluck' }, throwing)).toEqual({
      preset: 'pluck',
    });
  });

  it('carries the GM program flag over from the instrument patch', () => {
    const draft = createPatchDraft(
      { kind: 'synth-patch', patch: { preset: 'saw-lead', useGmPrograms: true } },
      () => null,
    );
    expect(draft.useGmPrograms).toBe(true);
  });

  it('never copies the binding-internal destinationId', () => {
    const draft = createPatchDraft(
      { kind: 'synth-patch', patch: { destinationId: 3, gain: 0.5 } },
      () => null,
    );
    expect(draft).toEqual({ gain: 0.5 });
  });
});

describe('sanitizePatchDraft', () => {
  it('clamps numerics and drops the keep-base enum spelling', () => {
    const patch = sanitizePatchDraft({
      preset: 'saw-lead',
      cutoffHz: 99999,
      drive: 0,
      lfo2RateHz: 99,
      bodyMix: 0.4,
      busDrive: 0.7,
      waveform: 'square',
      filterModel: 'default',
      gain: 0.5,
    });
    expect(patch).toEqual({
      preset: 'saw-lead',
      cutoffHz: 20000,
      drive: 0,
      lfo2RateHz: 20,
      bodyMix: 0.4,
      busDrive: 0.7,
      waveform: 'square',
      gain: 0.5,
    });
  });

  it('emits explicit zero numeric fields verbatim', () => {
    const patch = sanitizePatchDraft({
      ampSustain: 0,
      filterSustain: 0,
      drive: 0,
      envToCutoffCents: 0,
      glideMs: 0,
    });
    expect(patch).toEqual({
      ampSustain: 0,
      filterSustain: 0,
      drive: 0,
      envToCutoffCents: 0,
      glideMs: 0,
    });
  });

  it('drops non-finite numeric fields', () => {
    expect(sanitizePatchDraft({ gain: Number.NaN, cutoffHz: 440 })).toEqual({ cutoffHz: 440 });
  });

  it('carries the GM program flag only when enabled', () => {
    expect(sanitizePatchDraft({ useGmPrograms: true }).useGmPrograms).toBe(true);
    expect('useGmPrograms' in sanitizePatchDraft({ useGmPrograms: false })).toBe(false);
    expect('useGmPrograms' in sanitizePatchDraft({})).toBe(false);
  });

  it('filters and clamps mod routings', () => {
    const patch = sanitizePatchDraft({
      modRoutings: [
        { source: 'none', destination: 'amp-gain', depth: 1 },
        { source: 'lfo1', destination: 'pitch-cents', depth: -7 },
      ],
    });
    expect(patch.modRoutings).toEqual([{ source: 'lfo1', destination: 'pitch-cents', depth: -1 }]);
  });

  it('emits an empty routing list to clear inherited modulations', () => {
    const patch = sanitizePatchDraft({
      modRoutings: [{ source: 'none', destination: 'none', depth: 0 }],
    });
    expect(patch.modRoutings).toEqual([]);
  });

  it('keeps the base mod matrix when the draft omits routings', () => {
    expect(sanitizePatchDraft({ gain: 0.5 }).modRoutings).toBeUndefined();
  });
});

describe('patchEditCount', () => {
  it('counts set fields excluding the preset reference', () => {
    expect(patchEditCount({ preset: 'saw-lead' })).toBe(0);
    expect(
      patchEditCount({
        preset: 'saw-lead',
        cutoffHz: 400,
        waveform: 'saw',
        modRoutings: [{ source: 'lfo1', destination: 'pitch-cents', depth: 0.5 }],
      }),
    ).toBe(3);
  });
});

describe('adsrEnvelopePoints', () => {
  it('produces a five-point polyline spanning the canvas', () => {
    const points = adsrEnvelopePoints(100, 100, 0.5, 200, 160, 40);
    expect(points).toHaveLength(5);
    expect(points[0]).toEqual({ x: 0, y: 40 });
    expect(points[1].y).toBe(0);
    expect(points[2].y).toBeCloseTo(20);
    expect(points[3].y).toBeCloseTo(20);
    expect(points[4]).toEqual({ x: 160, y: 40 });
    // Monotonic x positions.
    for (let i = 1; i < points.length; i++) {
      expect(points[i].x).toBeGreaterThan(points[i - 1].x);
    }
  });

  it('keeps degenerate zero-time envelopes visible', () => {
    const points = adsrEnvelopePoints(0, 0, 1, 0, 160, 40);
    expect(points[1].x).toBeGreaterThanOrEqual(1);
    expect(points[2].x).toBeGreaterThan(points[1].x);
  });
});

describe('resolveSynthEnums', () => {
  it('falls back to the published constants', () => {
    const enums = resolveSynthEnums(null);
    expect(enums).toEqual(FALLBACK_SYNTH_ENUMS);
    expect(enums.waveforms).toContain('saw');
    expect(enums.modDestinations).toContain('cutoff-cents');
  });

  it('mirrors every published constant table', () => {
    expect(FALLBACK_SYNTH_ENUMS).toEqual({
      engineModes: [...SYNTH_ENGINE_MODES],
      waveforms: [...SYNTH_OSC_WAVEFORMS],
      builtinWaveforms: [],
      filterModels: [...SYNTH_FILTER_MODELS],
      filterOutputs: [...SYNTH_FILTER_OUTPUTS],
      bodyTypes: [...SYNTH_BODY_TYPES],
      modSources: [...SYNTH_MOD_SOURCES],
      modDestinations: [...SYNTH_MOD_DESTINATIONS],
      controllerInputs: [...CONTROLLER_INPUTS],
      controllerAxes: [...CONTROLLER_AXES],
      articulations: [...ARTICULATIONS],
      mpeDimensions: [...MPE_DIMENSIONS],
      noteTrackings: [...NOTE_TRACKINGS],
    });
  });

  it('overrides only the non-empty runtime tables', () => {
    const enums = resolveSynthEnums({ waveforms: ['sine', 'super-saw'], modSources: [] });
    expect(enums.waveforms).toEqual(['sine', 'super-saw']);
    expect(enums.modSources).toEqual(FALLBACK_SYNTH_ENUMS.modSources);
  });
});

describe('patchFieldSpec', () => {
  it('resolves known ids and rejects unknown ones', () => {
    expect(patchFieldSpec('cutoffHz')).toMatchObject({ min: 20, max: 20000, unit: 'Hz' });
    expect(patchFieldSpec('nope')).toBeNull();
  });
});
