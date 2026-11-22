import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  catalogParamInfo,
  clampToAccepted,
  editedProcessorParams,
  isConstructionOnlyParam,
  processorControl,
  setProcessingSampleRate,
  unitLabel,
  validateProcessorControlValue,
} from '@/project/processor-controls';
import { setWasmModule } from '@/project/runtime';
import {
  categoryLabel,
  groupInsertCatalogEntries,
  loadInsertCatalogEntries,
} from '@/ui/mixer/insert-catalog';
import * as wasm from '@/wasm/index.js';

beforeAll(async () => {
  await wasm.init({
    wasmBinary: readFileSync(`${process.cwd()}/src/wasm/sonare.wasm`),
  } as Parameters<typeof wasm.init>[0]);
  setWasmModule(wasm as unknown as Parameters<typeof setWasmModule>[0]);
});

afterAll(() => setProcessingSampleRate(undefined));

function numberControl(processor: string, key: string, raw?: number) {
  const info = catalogParamInfo(processor).find((entry) => entry.name === key);
  const control = processorControl(processor, key, raw, info);
  if (control?.kind !== 'number') throw new Error(`${processor}.${key} is not a number control`);
  return control;
}

describe('insert descriptor drives the controls', () => {
  it('uses uiMin/uiMax as the display range and keeps the accepted range for typed values', () => {
    const control = numberControl('voice.changer', 'inputGainDb');
    expect(control).toMatchObject({ min: -12, max: 12, unit: 'dB' });
    expect(clampToAccepted(control, 30)).toBe(24);
    expect(clampToAccepted(control, -30)).toBe(-24);
  });

  it('leaves a coupled key to the engine instead of its bounds at the siblings defaults', () => {
    const control = numberControl('dynamics.compressor', 'thresholdDb');
    expect(control).toMatchObject({ min: -60, max: 0, coupledWith: ['autoMakeup'] });
    expect(clampToAccepted(control, 30)).toBe(30);
  });

  it('draws a log axis from the declared positive display floor', () => {
    expect(numberControl('voice.changer', 'eqHighPassHz')).toMatchObject({
      min: 20,
      max: 300,
      scale: 'log',
    });
    // Compressor attack accepts zero; its log axis starts at the declared uiMin.
    expect(numberControl('dynamics.compressor', 'attackMs')).toMatchObject({
      min: 0.1,
      max: 200,
      scale: 'log',
    });
  });

  it('maps descriptor units to readout suffixes', () => {
    expect(numberControl('voice.changer', 'limiterCeilingDb').unit).toBe('dBFS');
    expect(numberControl('voice.changer', 'compressorRatio').unit).toBeUndefined();
    expect(unitLabel('percent')).toBe('%');
    expect(unitLabel('samples')).toBe('smp');
    expect(unitLabel('mystery')).toBe('mystery');
  });

  it('offers no value on an exclusive bound', () => {
    const control = numberControl('dynamics.deesser', 'frequencyHz');
    expect(control.min).toBeGreaterThan(0);
    expect(() => validateProcessorControlValue(control, 0)).toThrow(RangeError);
    expect(clampToAccepted(control, 0)).toBeGreaterThan(0);
  });

  it('resolves the Nyquist ceiling at the processing rate', () => {
    setProcessingSampleRate(16000);
    const control = numberControl('eq.parametric', 'band0.frequencyHz');
    setProcessingSampleRate(undefined);
    expect(control.accepts?.max).toBe(8000);
    expect(control.accepts?.maxExclusive).toBe(true);
    expect(control.max).toBeLessThan(8000);
  });

  it('holds hopLength to half the live nFft', () => {
    const next = editedProcessorParams('repair.denoiseClassical', { nFft: 256 }, 'hopLength', 512);
    expect(next.hopLength).toBe(128);
    const dflt = editedProcessorParams('repair.denoiseClassical', {}, 'hopLength', 512);
    expect(dflt.hopLength).toBe(512);
  });
});

describe('new realtime inserts', () => {
  it('lists voice.changer under a Voice group', () => {
    const entries = loadInsertCatalogEntries('realtime');
    const ids = entries.map((entry) => entry.id);
    for (const id of [
      'voice.changer',
      'repair.decrackle',
      'repair.dehum',
      'repair.denoiseClassical',
      'repair.dereverbClassical',
      'saturation.overdrive',
      'saturation.distortion',
    ]) {
      expect(ids).toContain(id);
    }
    const group = groupInsertCatalogEntries(entries).find((g) => g.category === 'voice');
    expect(group?.label).toBe('Voice');
    expect(categoryLabel('voice')).toBe('Voice');
  }, 60_000);

  it('treats voice.changer construction-only keys as rebuild keys', () => {
    for (const key of [
      'retuneGrainSizeSamples',
      'limiterEnableIspLimiter',
      'reverbSeed',
      'formantMode',
    ]) {
      expect(isConstructionOnlyParam('voice.changer', key), key).toBe(true);
    }
    expect(isConstructionOnlyParam('voice.changer', 'wetMix')).toBe(false);
  });
});
