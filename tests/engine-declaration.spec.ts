import { describe, expect, it } from 'vitest';
import {
  engineAutomationPoints,
  engineBusStrip,
  engineEqBands,
  stripSceneFieldsHaveDsp,
} from '@/engine/engine-declaration';
import { createDefaultStrip } from '@/project/mixer';

describe('engine declaration helpers', () => {
  it('filters invalid automation points and encodes curves', () => {
    expect(
      engineAutomationPoints([
        { ppq: 0, value: 1, curve: 'linear' },
        { ppq: Number.NaN, value: 2 },
        { ppq: 1, value: Number.POSITIVE_INFINITY },
        { ppq: 2, value: 3, curve: 'hold' },
      ]),
    ).toEqual([
      { ppq: 0, value: 1, curveToNext: 0 },
      { ppq: 2, value: 3, curveToNext: 2 },
    ]);
  });

  it('declares EQ bands only while the strip EQ is enabled', () => {
    const bands = [{ type: 'Peak', frequencyHz: 1000, gainDb: 3 }];
    expect(engineEqBands({ ...createDefaultStrip(), eq: { enabled: false, bands } })).toEqual([]);
    expect(engineEqBands({ ...createDefaultStrip(), eq: { enabled: true, bands } })).toBe(bands);
  });

  it('omits disabled inserts from bus strip scenes', () => {
    const strip = {
      ...createDefaultStrip(),
      inserts: [
        { processor: 'dynamics.compressor', params: {}, enabled: false },
        { processor: 'saturation.tape', params: { drive: 0.5 }, enabled: true },
      ],
    };

    expect(engineBusStrip(strip)?.inserts).toEqual([
      { processor: 'saturation.tape', params: { drive: 0.5 }, enabled: true },
    ]);
    expect(strip.inserts).toHaveLength(2);
  });

  it('detects strip scene DSP fields independently of inserts and EQ', () => {
    expect(stripSceneFieldsHaveDsp(undefined)).toBe(false);
    expect(stripSceneFieldsHaveDsp(createDefaultStrip())).toBe(false);
    expect(stripSceneFieldsHaveDsp({ ...createDefaultStrip(), width: 0.5 })).toBe(true);
    expect(stripSceneFieldsHaveDsp({ ...createDefaultStrip(), polarityInvertLeft: true })).toBe(
      true,
    );
  });
});
