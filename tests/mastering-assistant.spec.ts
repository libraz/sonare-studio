import { describe, expect, it } from 'vitest';
import { suggestedAdjustments, suggestedPresetOverrides } from '@/ui/mastering/assistant';
import {
  deleteChainPath,
  flattenChainConfig,
  getChainPath,
  isEmptyChainConfig,
  setChainPath,
} from '@/ui/mastering/chain-config-path';
import type { MasteringChainConfig } from '@/wasm/index.js';

const SUGGESTED: MasteringChainConfig = {
  loudness: { targetLufs: -14, ceilingDbtp: -1 },
  eq: { tilt: { enabled: true } },
  dynamics: { compressor: { ratio: 2.0000001 } },
};
const PRESET: MasteringChainConfig = {
  loudness: { targetLufs: -12, ceilingDbtp: -1 },
  eq: { tilt: { enabled: false } },
  dynamics: { compressor: { ratio: 2 } },
};

describe('suggestedPresetOverrides', () => {
  it('keeps only the fields where the suggestion departs from the preset', () => {
    expect(suggestedPresetOverrides(SUGGESTED, PRESET)).toEqual({
      loudness: { targetLufs: -14 },
      eq: { tilt: { enabled: true } },
    });
  });

  it('lists each adjustment with the preset value it replaces', () => {
    expect(suggestedAdjustments(SUGGESTED, PRESET)).toEqual([
      { key: 'loudness.targetLufs', from: -12, to: -14 },
      { key: 'eq.tilt.enabled', from: false, to: true },
    ]);
  });

  it('treats a field the preset leaves unset as an adjustment', () => {
    expect(suggestedAdjustments({ loudness: { enabled: true } }, {})).toEqual([
      { key: 'loudness.enabled', from: undefined, to: true },
    ]);
  });
});

describe('chain config paths', () => {
  const config: MasteringChainConfig = { loudness: { targetLufs: -14, enabled: true } };

  it('reads, sets and deletes by dotted path without mutating the input', () => {
    expect(getChainPath(config, 'loudness.targetLufs')).toBe(-14);
    expect(getChainPath(config, 'repair.denoise.enabled')).toBeUndefined();
    const set = setChainPath(config, 'repair.denoise.reductionDb', 30);
    expect(set).toEqual({ ...config, repair: { denoise: { reductionDb: 30 } } });
    expect(config).toEqual({ loudness: { targetLufs: -14, enabled: true } });
    expect(deleteChainPath(set, 'repair.denoise.reductionDb')).toEqual(config);
  });

  it('flattens to leaf paths and recognizes an empty config', () => {
    expect(flattenChainConfig(config)).toEqual([
      { path: 'loudness.targetLufs', value: -14 },
      { path: 'loudness.enabled', value: true },
    ]);
    expect(isEmptyChainConfig(undefined)).toBe(true);
    expect(isEmptyChainConfig({ loudness: {} })).toBe(true);
    expect(isEmptyChainConfig(config)).toBe(false);
  });
});
