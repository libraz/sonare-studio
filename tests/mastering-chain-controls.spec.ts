import { describe, expect, it } from 'vitest';
import type { InsertSlot } from '@/project/mixer';
import { clampControlValue, masteringProcessorControls } from '@/ui/mastering/chain-controls';

const COMPRESSOR_INFO = [
  {
    name: 'thresholdDb',
    type: 'number',
    unit: 'dB',
    min: null,
    max: null,
    default: -18,
    uiMin: -60,
    uiMax: 0,
  },
  {
    name: 'attackMs',
    type: 'number',
    unit: 'ms',
    min: 0,
    max: null,
    default: 10,
    uiMin: 0,
    uiMax: 200,
    scale: 'log',
  },
  {
    name: 'releaseMs',
    type: 'number',
    unit: 'ms',
    min: 0,
    max: null,
    default: 100,
    uiMin: 0,
    uiMax: 2000,
    scale: 'log',
  },
  {
    name: 'makeupGainDb',
    type: 'number',
    unit: 'dB',
    min: null,
    max: 770.636,
    default: 0,
    uiMin: -12,
    uiMax: 24,
  },
] as const;

function slot(processor: string, params: Record<string, number> = {}): InsertSlot {
  return { processor, params, enabled: true };
}

describe('mastering chain controls', () => {
  it('prefers the descriptor display range over name heuristics', () => {
    const controls = masteringProcessorControls(
      slot('dynamics.compressor', { thresholdDb: -18 }),
      () => ['thresholdDb', 'attackMs', 'releaseMs', 'makeupGainDb'],
      () => [...COMPRESSOR_INFO],
    );

    expect(controls.find((c) => c.id === 'thresholdDb')).toMatchObject({
      value: -18,
      min: -60,
      max: 0,
      unit: 'dB',
    });
    expect(controls.find((c) => c.id === 'attackMs')).toMatchObject({
      value: 10,
      min: 0.2,
      max: 200,
      scale: 'log',
      unit: 'ms',
    });
    expect(controls.find((c) => c.id === 'releaseMs')).toMatchObject({
      min: 2,
      max: 2000,
      scale: 'log',
      unit: 'ms',
    });
    expect(controls.find((c) => c.id === 'makeupGainDb')).toMatchObject({
      min: -12,
      max: 24,
      unit: 'dB',
      defaultValue: 0,
    });
  });

  it('keeps name heuristics only for unknown custom processors', () => {
    const controls = masteringProcessorControls(slot('custom.weird'), () => [
      'resonanceQ',
      'q',
      'quantize',
      'quality',
    ]);

    expect(controls.find((c) => c.id === 'resonanceQ')).toMatchObject({
      min: 0.1,
      max: 18,
      scale: 'log',
      defaultValue: Math.SQRT1_2,
    });
    expect(controls.find((c) => c.id === 'q')).toMatchObject({ min: 0.1, max: 18, scale: 'log' });
    expect(controls.find((c) => c.id === 'quantize')).toMatchObject({ min: 0, max: 1 });
    expect(controls.find((c) => c.id === 'quality')).toMatchObject({ min: 0, max: 1 });
  });

  it('shows every catalog parameter and prioritizes explicitly saved values', () => {
    const catalog = Array.from({ length: 12 }, (_, index) => `param${index + 1}`);
    const controls = masteringProcessorControls(
      slot('custom.wide', { customGain: 0.5 }),
      () => catalog,
    );

    expect(controls).toHaveLength(13);
    expect(controls.map((control) => control.id)).toEqual([...catalog, 'customGain']);
    expect(controls.at(-1)).toMatchObject({ value: 0.5 });
  });

  it('uses the resolved control range for clamping', () => {
    const [control] = masteringProcessorControls(
      slot('dynamics.compressor'),
      () => ['attackMs'],
      () => [...COMPRESSOR_INFO],
    );

    expect(clampControlValue(control, 900)).toBe(200);
    expect(clampControlValue(control, -5)).toBe(0.2);
  });
});
