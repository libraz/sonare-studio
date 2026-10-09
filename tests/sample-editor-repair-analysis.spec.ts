import { describe, expect, it } from 'vitest';
import {
  checkedRepairStages,
  declipWithheld,
  repairChannelLabel,
  repairChannelSummaries,
  repairDefectItems,
} from '@/ui/sample-editor/repair-analysis';
import { wasmOpAvailability } from '@/ui/sample-editor/wasm-ops';
import type { MasteringAudioProfileDefects, MasteringRepairAnalysis } from '@/wasm/index.js';

function defects(
  overrides: Partial<MasteringAudioProfileDefects> = {},
): MasteringAudioProfileDefects {
  return {
    measured: true,
    clickCount: 0,
    clickRejected: 0,
    clickLongestRunSamples: 0,
    clickPerSecond: 0,
    crackleSampleCount: 0,
    crackleSampleFraction: 0,
    cracklePerSecond: 0,
    clipSampleCount: 0,
    clipRunCount: 0,
    clipLongestRunSamples: 0,
    clipSampleFraction: 0,
    clipFlatRunCount: 0,
    clipFlatSampleCount: 0,
    clipLongestFlatRunSamples: 0,
    clipFlatLevel: 0,
    noiseFloorDbfs: -72.4,
    noiseBandPeakDbfs: -60,
    noiseBandPeakIndex: 0,
    humFundamentalHz: 0,
    humFundamentalProminence: 0,
    humHarmonics: 0,
    humFundamentalDbfs: -120,
    humPeakHarmonicDbfs: -120,
    lateDecayRatioDb: 0,
    ...overrides,
  };
}

function analysis(overrides: Partial<MasteringRepairAnalysis> = {}): MasteringRepairAnalysis {
  return {
    defects: defects(),
    channels: [defects(), defects()],
    declipThresholdSafe: true,
    integratedLufs: -18,
    recommended: [{ stage: 'declick' }, { stage: 'dehum', fundamentalHz: 50 }],
    explanation: [],
    ...overrides,
  };
}

describe('repairChannelLabel', () => {
  it('names mono, stereo and wider layouts', () => {
    expect(repairChannelLabel(0, 1)).toBe('M');
    expect([repairChannelLabel(0, 2), repairChannelLabel(1, 2)]).toEqual(['L', 'R']);
    expect(repairChannelLabel(2, 6)).toBe('3');
  });
});

describe('repairDefectItems', () => {
  it('lists only the defects found, plus the noise floor', () => {
    expect(repairDefectItems(defects())).toEqual([{ kind: 'noise', value: '-72 dBFS' }]);
    expect(
      repairDefectItems(
        defects({
          clickCount: 12,
          clipRunCount: 3,
          crackleSampleCount: 40,
          cracklePerSecond: 2.345,
          humFundamentalHz: 59.8,
        }),
      ),
    ).toEqual([
      { kind: 'clicks', value: '12' },
      { kind: 'clipping', value: '3' },
      { kind: 'crackle', value: '2.3/s' },
      { kind: 'hum', value: '60 Hz' },
      { kind: 'noise', value: '-72 dBFS' },
    ]);
  });

  it('is empty for an unmeasured channel', () => {
    expect(repairDefectItems(defects({ measured: false, clickCount: 5 }))).toEqual([]);
  });
});

describe('repairChannelSummaries', () => {
  it('builds one labelled row per channel', () => {
    const rows = repairChannelSummaries(
      analysis({ channels: [defects({ clickCount: 1 }), defects()] }),
    );
    expect(rows.map((row) => row.channel)).toEqual(['L', 'R']);
    expect(rows[0].items[0]).toEqual({ kind: 'clicks', value: '1' });
  });
});

describe('declipWithheld', () => {
  it('flags flat runs the analysis declined to declip', () => {
    expect(declipWithheld(analysis())).toBe(false);
    expect(
      declipWithheld(
        analysis({ declipThresholdSafe: false, defects: defects({ clipFlatRunCount: 2 }) }),
      ),
    ).toBe(true);
    expect(declipWithheld(analysis({ declipThresholdSafe: false }))).toBe(false);
  });
});

describe('checkedRepairStages', () => {
  it('keeps checked recommended stages with their settings', () => {
    const result = analysis();
    expect(checkedRepairStages(result, { declick: false, dehum: true })).toEqual([
      { stage: 'dehum', fundamentalHz: 50 },
    ]);
    expect(checkedRepairStages(result, {})).toEqual([]);
  });
});

describe('wasmOpAvailability for the new operations', () => {
  it('needs both repair-session calls and reports auto-tune on its own', () => {
    const fn = () => undefined;
    expect(wasmOpAvailability({ masteringRepairAnalyze: fn } as never).repairSession).toBe(false);
    expect(
      wasmOpAvailability({ masteringRepairAnalyze: fn, masteringRepairApply: fn } as never)
        .repairSession,
    ).toBe(true);
    expect(wasmOpAvailability({ autoTune: fn } as never).autoTune).toBe(true);
  });
});
