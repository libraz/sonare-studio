import type { MasteringAudioProfileDefects, MasteringRepairAnalysis } from '@libraz/libsonare';
import { describe, expect, it } from 'vitest';
import {
  checkedRepairStages,
  declipWithheld,
  repairChannelLabel,
  repairChannelSummaries,
  repairDefectItems,
} from '@/ui/sample-editor/repair-analysis';
import { wasmOpAvailability } from '@/ui/sample-editor/wasm-ops';

interface DefectOverrides {
  clickCount?: number;
  clipRunCount?: number;
  clipFlatRunCount?: number;
  crackleSampleCount?: number;
  cracklePerSecond?: number;
  humFundamentalHz?: number;
}

function defects(overrides: DefectOverrides = {}): MasteringAudioProfileDefects {
  return {
    click: {
      count: overrides.clickCount ?? 0,
      rejected: 0,
      longestRunSamples: 0,
      perSecond: 0,
    },
    crackle: {
      sampleCount: overrides.crackleSampleCount ?? 0,
      sampleFraction: 0,
      perSecond: overrides.cracklePerSecond ?? 0,
    },
    clip: {
      clippedSamples: 0,
      clippedRatio: 0,
      runCount: overrides.clipRunCount ?? 0,
      longestRunSamples: 0,
      flatRunCount: overrides.clipFlatRunCount ?? 0,
      longestFlatRunSamples: 0,
      flatSampleCount: 0,
      flatLevel: 0,
    },
    noise: { floorDbfs: -72.4, bandFloorDbfs: new Float32Array(0) },
    hum: {
      fundamentalHz: overrides.humFundamentalHz ?? 0,
      fundamentalProminence: 0,
      harmonics: 0,
      harmonicDbfs: new Float32Array(0),
    },
    reverb: { lateDecayRatioDb: 0 },
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

describe('repairChannelSummaries without detectors', () => {
  it('has no rows when the analysis carries no channel defects', () => {
    expect(repairChannelSummaries(analysis({ channels: undefined }))).toEqual([]);
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
