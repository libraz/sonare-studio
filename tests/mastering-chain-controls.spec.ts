import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { InsertSlot } from '@/project/mixer';
import { clampControlValue, masteringProcessorControls } from '@/ui/mastering/chain-controls';
import type { SoloProcessor } from '@/wasm/index.js';
import * as core from '@/wasm/index.js';
import { fakeParamInfo, unsupportedProcessor } from './fakes/engine';

const COMPRESSOR_INFO = [
  fakeParamInfo({
    name: 'thresholdDb',
    unit: 'dB',
    default: -18,
    uiMin: -60,
    uiMax: 0,
  }),
  fakeParamInfo({
    name: 'attackMs',
    unit: 'ms',
    min: 0,
    default: 10,
    uiMin: 0.1,
    uiMax: 200,
    scale: 'log',
  }),
  fakeParamInfo({
    name: 'releaseMs',
    unit: 'ms',
    min: 0,
    default: 100,
    uiMin: 0.1,
    uiMax: 2000,
    scale: 'log',
  }),
  fakeParamInfo({
    name: 'makeupGainDb',
    unit: 'dB',
    max: 770.636,
    default: 0,
    uiMin: -12,
    uiMax: 24,
  }),
];

function slot(processor: SoloProcessor, params: Record<string, number> = {}): InsertSlot {
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
      min: 0.1,
      max: 200,
      scale: 'log',
      unit: 'ms',
    });
    expect(controls.find((c) => c.id === 'releaseMs')).toMatchObject({
      min: 0.1,
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
    const controls = masteringProcessorControls(slot(unsupportedProcessor('custom.weird')), () => [
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
      slot('utility.gain', { customGain: 0.5 }),
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
    expect(clampControlValue(control, -5)).toBe(0.1);
  });
});

describe('mastering chain controls against the real core catalog', () => {
  beforeAll(async () => {
    await core.init({ wasmBinary: readFileSync(`${process.cwd()}/src/wasm/sonare.wasm`) });
  });

  it('derives the display range of compressor controls from the core descriptors', () => {
    const controls = masteringProcessorControls(
      slot('dynamics.compressor', { thresholdDb: -18 }),
      () => core.masteringInsertParamNames('dynamics.compressor'),
      () => core.masteringInsertParamInfo({ insert: 'dynamics.compressor' }),
    );

    expect(controls.map((control) => control.id)).toEqual(
      expect.arrayContaining(['thresholdDb', 'attackMs', 'releaseMs']),
    );
    expect(controls.find((control) => control.id === 'thresholdDb')).toMatchObject({
      min: -60,
      max: 0,
    });
    expect(controls.find((control) => control.id === 'attackMs')).toMatchObject({
      min: 0.1,
      max: 200,
      scale: 'log',
    });
    expect(controls.find((control) => control.id === 'thresholdDb')?.value).toBe(-18);
  });
});
