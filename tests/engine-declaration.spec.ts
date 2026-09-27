import { describe, expect, it } from 'vitest';
import {
  engineAutomationPoints,
  engineBusPanHasDsp,
  engineBusPanState,
  engineBusStrip,
  engineBusStripHasDsp,
  engineEqBands,
  engineFaderAutomationPoints,
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

  it('keeps fader automation pinned to the silence floor while muted', () => {
    expect(
      engineFaderAutomationPoints(
        [
          { ppq: 0, value: -12 },
          { ppq: 4, value: 0, curve: 'hold' },
        ],
        -6,
        true,
      ),
    ).toEqual([
      { ppq: 0, value: -120, curveToNext: 0 },
      { ppq: 4, value: -120, curveToNext: 2 },
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

  it('encodes neutral bus pan defaults without inventing DSP', () => {
    expect(engineBusPanState(createDefaultStrip())).toEqual({
      pan: 0,
      panLaw: 0,
      panMode: 0,
      dualPanLeft: -1,
      dualPanRight: 1,
    });
    expect(engineBusPanHasDsp(createDefaultStrip())).toBe(false);
    expect(engineBusStripHasDsp(createDefaultStrip())).toBe(false);
  });

  it('detects pan-only bus DSP and maps string modes/laws to libsonare codes', () => {
    const strip = {
      ...createDefaultStrip(),
      pan: 0.25,
      panLaw: 'linear0dB' as const,
      panMode: 'dualPan' as const,
      dualPan: { left: -0.5, right: 0.75 },
    };
    expect(engineBusPanState(strip)).toEqual({
      pan: 0.25,
      panLaw: 3,
      panMode: 2,
      dualPanLeft: -0.5,
      dualPanRight: 0.75,
    });
    expect(engineBusPanHasDsp(strip)).toBe(true);
    expect(engineBusStripHasDsp(strip)).toBe(true);
  });
});
