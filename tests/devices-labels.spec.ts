import { describe, expect, it } from 'vitest';
import {
  insertCategory,
  insertLabel,
  instrumentKindLabel,
  instrumentLabel,
  patchBaseLabel,
} from '@/ui/devices/device-labels';
import { formatControlValue, knobRotationDeg, knobValueForDrag } from '@/ui/devices/knob-math';

describe('instrumentLabel', () => {
  it('shows the preset name for synth presets', () => {
    expect(instrumentLabel({ kind: 'synth-preset', preset: 'warm-pad' })).toBe('warm-pad');
  });

  it('marks edited patches with their base preset', () => {
    expect(
      instrumentLabel({ kind: 'synth-patch', patch: { preset: 'saw-lead', cutoffHz: 400 } }),
    ).toBe('saw-lead (edited)');
    expect(instrumentLabel({ kind: 'synth-patch', patch: { cutoffHz: 400 } })).toBe(
      'init (edited)',
    );
    // A patch carrying only the preset reference is not "edited".
    expect(instrumentLabel({ kind: 'synth-patch', patch: { preset: 'saw-lead' } })).toBe(
      'saw-lead',
    );
  });

  it('shows the font name with bank:program for sf2', () => {
    const instrument = { kind: 'sf2', fontId: 'abcdef0123456789', bank: 128, program: 25 } as const;
    expect(instrumentLabel(instrument, 'GM.sf2')).toBe('GM.sf2 · 128:25');
    expect(instrumentLabel(instrument)).toBe('abcdef01… · 128:25');
    expect(instrumentLabel({ kind: 'sf2', fontId: 'abcdef0123456789' }, 'GM.sf2')).toBe(
      'GM.sf2 · 0:0',
    );
  });
});

describe('instrumentKindLabel / patchBaseLabel', () => {
  it('badges each instrument kind', () => {
    expect(instrumentKindLabel({ kind: 'synth-preset', preset: 'sine' })).toBe('Preset');
    expect(instrumentKindLabel({ kind: 'synth-patch', patch: {} })).toBe('Patch');
    expect(instrumentKindLabel({ kind: 'sf2', fontId: 'x' })).toBe('SF2');
  });

  it('falls back to init for base-less patches', () => {
    expect(patchBaseLabel({})).toBe('init');
    expect(patchBaseLabel({ preset: 'organ' })).toBe('organ');
  });
});

describe('insertLabel / insertCategory', () => {
  it('humanizes the catalog name segments', () => {
    expect(insertLabel('dynamics.compressor')).toBe('Compressor');
    expect(insertLabel('saturation.softClipper')).toBe('Soft Clipper');
    expect(insertLabel('eq.tilt')).toBe('Tilt');
    expect(insertCategory('dynamics.compressor')).toBe('dynamics');
    expect(insertCategory('custom')).toBe('');
  });
});

describe('knobValueForDrag', () => {
  it('maps a full upward sweep to the range maximum', () => {
    expect(knobValueForDrag(0, -150, 0, 1)).toBe(1);
    expect(knobValueForDrag(0.5, 0, 0, 1)).toBe(0.5);
  });

  it('clamps beyond the range and supports fine adjustment', () => {
    expect(knobValueForDrag(0.9, -150, 0, 1)).toBe(1);
    expect(knobValueForDrag(0.5, 150, 0, 1)).toBe(0);
    expect(knobValueForDrag(0.5, -150, 0, 1, true)).toBeCloseTo(0.6);
  });
});

describe('knobRotationDeg', () => {
  it('sweeps -135..135 degrees across the range', () => {
    expect(knobRotationDeg(0, 0, 1)).toBe(-135);
    expect(knobRotationDeg(0.5, 0, 1)).toBe(0);
    expect(knobRotationDeg(1, 0, 1)).toBe(135);
    expect(knobRotationDeg(5, 0, 1)).toBe(135);
  });

  it('degrades empty ranges to the minimum position', () => {
    expect(knobRotationDeg(1, 1, 1)).toBe(-135);
  });
});

describe('formatControlValue', () => {
  it('scales precision with magnitude and appends units', () => {
    expect(formatControlValue(12000, 'Hz')).toBe('12000 Hz');
    expect(formatControlValue(120.04, 'ms')).toBe('120 ms');
    expect(formatControlValue(0.5)).toBe('0.5');
    expect(formatControlValue(0)).toBe('0');
    expect(formatControlValue(-24, 'dB')).toBe('-24 dB');
  });

  it('renders non-finite values as a placeholder', () => {
    expect(formatControlValue(Number.NaN)).toBe('—');
  });
});
