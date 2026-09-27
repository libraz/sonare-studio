import { describe, expect, it } from 'vitest';
import {
  getPresetControlDescriptor,
  hasPresetControlOverride,
  isKnownPresetOverrideKey,
  LEGACY_DENOISE_OVERRIDE_KEY,
  PRESET_CONTROL_DESCRIPTORS,
  parsePresetControlValue,
  presetControlOverrideKey,
  presetControlOverridesForEdit,
  presetControlOverridesForReset,
  resolvePresetControlValue,
} from '@/ui/mastering/preset-controls';

const target = getPresetControlDescriptor('loudness.targetLufs');
const ceiling = getPresetControlDescriptor('loudness.ceilingDb');
const denoiseEnabled = getPresetControlDescriptor('repair.denoise.enabled');
const denoise = getPresetControlDescriptor('repair.denoise.reductionDb');
const oversample = getPresetControlDescriptor('loudness.truePeakOversample');

if (!target || !ceiling || !denoiseEnabled || !denoise || !oversample)
  throw new Error('preset control descriptors are incomplete');

describe('mastering preset controls', () => {
  it('defines the compact output and restoration surface', () => {
    expect(PRESET_CONTROL_DESCRIPTORS.map(({ key }) => key)).toEqual([
      'loudness.enabled',
      'loudness.targetLufs',
      'loudness.ceilingDb',
      'loudness.truePeakOversample',
      'loudness.releaseMs',
      'loudness.maxLimiterGainReductionDb',
      'repair.denoise.enabled',
      'repair.denoise.reductionDb',
    ]);
    expect(oversample.options).toEqual([1, 2, 4, 8, 16]);
  });

  it('resolves saved overrides before runtime preset params', () => {
    expect(
      resolvePresetControlValue(
        target,
        { 'loudness.targetLufs': -16 },
        { 'loudness.targetLufs': -12 },
      ),
    ).toBe(-12);
    expect(resolvePresetControlValue(target, { 'loudness.targetLufs': -16 }, {})).toBe(-16);
  });

  it('uses safe library defaults when wasm preset params are unavailable', () => {
    expect(resolvePresetControlValue(target)).toBe(-14);
    expect(resolvePresetControlValue(denoiseEnabled)).toBe(false);
    expect(resolvePresetControlValue(denoise)).toBe(26);
  });

  it('keeps a preset denoise stage disabled until explicitly enabled', () => {
    expect(resolvePresetControlValue(denoiseEnabled, { 'repair.denoise.enabled': true })).toBe(
      true,
    );
    expect(
      resolvePresetControlValue(
        denoiseEnabled,
        { 'repair.denoise.enabled': true },
        { 'repair.denoise.enabled': false },
      ),
    ).toBe(false);
    expect(resolvePresetControlValue(denoiseEnabled, {}, { 'repair.denoise.enabled': true })).toBe(
      true,
    );
    expect(resolvePresetControlValue(denoiseEnabled, { 'repair.denoise.enabled': true })).toBe(
      true,
    );
    expect(parsePresetControlValue(denoiseEnabled, true)).toBe(true);
    expect(parsePresetControlValue(denoiseEnabled, false)).toBe(false);
  });

  it('shows the core implicit-enable state of older parameter-only overrides', () => {
    const presetParams = { 'repair.denoise.enabled': false };
    expect(
      resolvePresetControlValue(denoiseEnabled, presetParams, {
        'repair.denoise.nFft': 2048,
      }),
    ).toBe(true);
    expect(
      resolvePresetControlValue(denoiseEnabled, presetParams, {
        'repair.reductionDb': 80,
      }),
    ).toBe(true);
    expect(
      resolvePresetControlValue(denoiseEnabled, presetParams, {
        'repair.denoise.enabled': false,
        'repair.denoise.nFft': 2048,
      }),
    ).toBe(false);
  });

  it('persists the displayed stage switch with a parameter-only edit', () => {
    const next = presetControlOverridesForEdit(
      denoise,
      80,
      { 'repair.denoise.enabled': false, 'repair.denoise.reductionDb': 26 },
      {},
    );
    expect(next).toEqual({
      'repair.denoise.enabled': false,
      'repair.denoise.reductionDb': 80,
    });

    const reset = presetControlOverridesForReset(
      denoise,
      { 'repair.denoise.enabled': false, 'repair.denoise.reductionDb': 26 },
      next,
    );
    expect(reset).toEqual({});
  });

  it('keeps a disabled stage explicit while another parameter override remains', () => {
    const presetParams = {
      'loudness.enabled': false,
      'loudness.targetLufs': -14,
      'loudness.ceilingDb': -1,
    };
    const withTarget = presetControlOverridesForEdit(target, -16, presetParams, {});
    const withBoth = presetControlOverridesForEdit(ceiling, -2, presetParams, withTarget);
    expect(withBoth).toEqual({
      'loudness.enabled': false,
      'loudness.targetLufs': -16,
      'loudness.ceilingDb': -2,
    });

    const afterTargetReset = presetControlOverridesForReset(target, presetParams, withBoth);
    expect(afterTargetReset).toEqual({
      'loudness.enabled': false,
      'loudness.ceilingDb': -2,
    });

    expect(presetControlOverridesForReset(ceiling, presetParams, afterTargetReset)).toEqual({});
  });

  it('restores an explicit disabled stage when resetting its switch with siblings', () => {
    const presetParams = {
      'repair.denoise.enabled': false,
      'repair.denoise.reductionDb': 26,
    };
    const overrides = {
      'repair.denoise.enabled': true,
      'repair.denoise.reductionDb': 80,
    };
    expect(presetControlOverridesForReset(denoiseEnabled, presetParams, overrides)).toEqual({
      'repair.denoise.enabled': false,
      'repair.denoise.reductionDb': 80,
    });
    expect(
      presetControlOverridesForReset(denoiseEnabled, presetParams, {
        'repair.denoise.enabled': true,
      }),
    ).toEqual({});
    expect(
      presetControlOverridesForReset(denoiseEnabled, presetParams, {
        'repair.denoise.reductionDb': 80,
      }),
    ).toEqual({
      'repair.denoise.enabled': false,
      'repair.denoise.reductionDb': 80,
    });
  });

  it('counts unknown Advanced parameters as stage siblings during reset', () => {
    const presetParams = { 'repair.denoise.enabled': false };
    expect(
      presetControlOverridesForReset(denoiseEnabled, presetParams, {
        'repair.denoise.enabled': true,
        'repair.denoise.nFft': 2048,
      }),
    ).toEqual({
      'repair.denoise.enabled': false,
      'repair.denoise.nFft': 2048,
    });
    expect(
      presetControlOverridesForReset(denoise, presetParams, {
        'repair.denoise.enabled': true,
        'repair.denoise.reductionDb': 80,
        'repair.denoise.nFft': 2048,
      }),
    ).toEqual({
      'repair.denoise.enabled': true,
      'repair.denoise.nFft': 2048,
    });
    expect(
      presetControlOverridesForReset(denoise, presetParams, {
        'repair.denoise.enabled': false,
        'repair.reductionDb': 18,
        'repair.denoise.nFft': 2048,
      }),
    ).toEqual({
      'repair.denoise.enabled': false,
      'repair.denoise.nFft': 2048,
    });
  });

  it('preserves libsonare-valid saved values beyond customary UI ranges', () => {
    expect(
      resolvePresetControlValue(
        target,
        { 'loudness.targetLufs': -14 },
        { 'loudness.targetLufs': -61 },
      ),
    ).toBe(-61);
    expect(
      resolvePresetControlValue(
        denoise,
        { 'repair.denoise.reductionDb': 26 },
        {
          'repair.denoise.reductionDb': 121,
        },
      ),
    ).toBe(121);
  });

  it('maps the legacy denoise alias without creating a second saved key', () => {
    const overrides = { [LEGACY_DENOISE_OVERRIDE_KEY]: 18 };
    expect(resolvePresetControlValue(denoise, {}, overrides)).toBe(18);
    expect(presetControlOverrideKey(denoise.key, overrides)).toBe(LEGACY_DENOISE_OVERRIDE_KEY);
    expect(hasPresetControlOverride(denoise.key, overrides)).toBe(true);
    expect(presetControlOverrideKey(denoise.key, {})).toBe(denoise.key);
  });

  it('accepts supported input and rejects invalid ranges and enum values', () => {
    expect(parsePresetControlValue(target, '-13.5')).toBe(-13.5);
    expect(parsePresetControlValue(denoise, 0)).toBe(0);
    expect(parsePresetControlValue(oversample, '8')).toBe(8);
    expect(() => parsePresetControlValue(target, '')).toThrow();
    // Earlier project versions could save these libsonare-valid values. They
    // must remain visible and editable even outside the usual mastering range.
    expect(parsePresetControlValue(target, -61)).toBe(-61);
    expect(parsePresetControlValue(denoise, 121)).toBe(121);
    expect(parsePresetControlValue(getPresetControlDescriptor('loudness.ceilingDb')!, 1)).toBe(1);
    expect(parsePresetControlValue(getPresetControlDescriptor('loudness.releaseMs')!, 6000)).toBe(
      6000,
    );
    expect(
      parsePresetControlValue(
        getPresetControlDescriptor('loudness.maxLimiterGainReductionDb')!,
        61,
      ),
    ).toBe(61);
    expect(() => parsePresetControlValue(target, 1e100)).toThrow();
    expect(() => parsePresetControlValue(denoise, -1)).toThrow();
    expect(() => parsePresetControlValue(oversample, 3)).toThrow();
  });

  it('recognizes only the typed keys and the backwards-compatible alias', () => {
    expect(isKnownPresetOverrideKey('loudness.targetLufs')).toBe(true);
    expect(isKnownPresetOverrideKey(LEGACY_DENOISE_OVERRIDE_KEY)).toBe(true);
    expect(isKnownPresetOverrideKey('limiter.truePeak')).toBe(false);
  });
});
