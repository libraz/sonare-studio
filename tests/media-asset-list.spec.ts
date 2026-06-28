import { describe, expect, it } from 'vitest';
import type { AudioAssetMeta } from '@/persistence/assets';
import {
  assetDurationSeconds,
  collectKeyTags,
  filterAssets,
  formatBpm,
  formatChannels,
  formatDuration,
  formatLufs,
  formatSampleRate,
  parseBpmRange,
  referencedAssetIds,
  sortAssets,
} from '@/ui/media/asset-list';

/** Builds asset metadata with sensible defaults. */
function meta(overrides: Partial<AudioAssetMeta> = {}): AudioAssetMeta {
  return {
    id: 'asset-1',
    name: 'Loop',
    sampleRate: 48000,
    numChannels: 2,
    numFrames: 48000,
    ...overrides,
  };
}

describe('parseBpmRange', () => {
  it('returns null for empty or blank input', () => {
    expect(parseBpmRange('')).toBeNull();
    expect(parseBpmRange('   ')).toBeNull();
  });

  it('parses a single number as an exact range', () => {
    expect(parseBpmRange('120')).toEqual({ min: 120, max: 120 });
    expect(parseBpmRange(' 97.5 ')).toEqual({ min: 97.5, max: 97.5 });
  });

  it('parses bounded, lower-only and upper-only ranges', () => {
    expect(parseBpmRange('80-120')).toEqual({ min: 80, max: 120 });
    expect(parseBpmRange('80 - 120')).toEqual({ min: 80, max: 120 });
    expect(parseBpmRange('80-')).toEqual({ min: 80 });
    expect(parseBpmRange('-120')).toEqual({ max: 120 });
  });

  it('rejects unparseable or inverted input', () => {
    expect(parseBpmRange('fast')).toBeNull();
    expect(parseBpmRange('80..120')).toBeNull();
    expect(parseBpmRange('-')).toBeNull();
    expect(parseBpmRange('120-80')).toBeNull();
  });
});

describe('duration and display formatting', () => {
  it('derives the duration from frames and sample rate', () => {
    expect(assetDurationSeconds(meta({ numFrames: 96000, sampleRate: 48000 }))).toBe(2);
    expect(assetDurationSeconds(meta({ numFrames: 0 }))).toBe(0);
    expect(assetDurationSeconds(meta({ sampleRate: 0 }))).toBe(0);
  });

  it('formats durations as m:ss.d', () => {
    expect(formatDuration(0)).toBe('0:00.0');
    expect(formatDuration(5.25)).toBe('0:05.3');
    expect(formatDuration(83)).toBe('1:23.0');
    expect(formatDuration(Number.NaN)).toBe('0:00.0');
    expect(formatDuration(-3)).toBe('0:00.0');
  });

  it('carries fractional rounding into the next minute', () => {
    expect(formatDuration(59.97)).toBe('1:00.0');
  });

  it('formats channel counts, sample rates and BPM values', () => {
    expect(formatChannels(1)).toBe('mono');
    expect(formatChannels(2)).toBe('stereo');
    expect(formatChannels(6)).toBe('6ch');
    expect(formatSampleRate(48000)).toBe('48 kHz');
    expect(formatSampleRate(44100)).toBe('44.1 kHz');
    expect(formatBpm(120)).toBe('120');
    expect(formatBpm(97.46)).toBe('97.5');
    expect(formatLufs(-14)).toBe('-14 LUFS');
    expect(formatLufs(-14.23)).toBe('-14.2 LUFS');
  });
});

describe('collectKeyTags', () => {
  it('returns the unique key tags sorted', () => {
    const assets = [
      meta({ id: 'a', tags: { key: 'Cm' } }),
      meta({ id: 'b', tags: { key: 'Am' } }),
      meta({ id: 'c', tags: { key: 'Cm' } }),
      meta({ id: 'd' }),
    ];
    expect(collectKeyTags(assets)).toEqual(['Am', 'Cm']);
  });
});

describe('filterAssets', () => {
  const assets = [
    meta({ id: 'a', name: 'Drum Loop', tags: { bpm: 120, key: 'Am' } }),
    meta({ id: 'b', name: 'Bass Hit', tags: { bpm: 90 } }),
    meta({ id: 'c', name: 'Vocal Take' }),
  ];

  it('matches all assets with an empty filter', () => {
    expect(filterAssets(assets, {})).toHaveLength(3);
  });

  it('filters by case-insensitive name substring', () => {
    expect(filterAssets(assets, { text: 'loop' }).map((a) => a.id)).toEqual(['a']);
    expect(filterAssets(assets, { text: '  BASS ' }).map((a) => a.id)).toEqual(['b']);
  });

  it('filters by exact key tag, excluding untagged assets', () => {
    expect(filterAssets(assets, { key: 'Am' }).map((a) => a.id)).toEqual(['a']);
    expect(filterAssets(assets, { key: 'Cm' })).toHaveLength(0);
  });

  it('filters by inclusive BPM range, excluding untagged assets', () => {
    expect(filterAssets(assets, { bpm: { min: 100 } }).map((a) => a.id)).toEqual(['a']);
    expect(filterAssets(assets, { bpm: { max: 100 } }).map((a) => a.id)).toEqual(['b']);
    expect(filterAssets(assets, { bpm: { min: 90, max: 120 } }).map((a) => a.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('combines criteria', () => {
    expect(
      filterAssets(assets, { text: 'o', bpm: { min: 100, max: 130 } }).map((a) => a.id),
    ).toEqual(['a']);
  });
});

describe('sortAssets', () => {
  const assets = [
    meta({ id: 'b', name: 'Beta', numFrames: 24000, tags: { bpm: 140, lufs: -20 } }),
    meta({ id: 'a', name: 'Alpha', numFrames: 96000 }),
    meta({ id: 'c', name: 'Gamma', numFrames: 48000, tags: { bpm: 90, lufs: -8 } }),
  ];

  it('sorts by name without mutating the input', () => {
    const sorted = sortAssets(assets, 'name');
    expect(sorted.map((a) => a.id)).toEqual(['a', 'b', 'c']);
    expect(assets.map((a) => a.id)).toEqual(['b', 'a', 'c']);
  });

  it('sorts by duration shortest-first', () => {
    expect(sortAssets(assets, 'duration').map((a) => a.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by BPM with untagged assets last', () => {
    expect(sortAssets(assets, 'bpm').map((a) => a.id)).toEqual(['c', 'b', 'a']);
  });

  it('sorts by loudness loudest-first with untagged assets last', () => {
    expect(sortAssets(assets, 'loudness').map((a) => a.id)).toEqual(['c', 'b', 'a']);
  });

  it('breaks ties by name then id', () => {
    const tied = [
      meta({ id: 'y', name: 'Same', numFrames: 100 }),
      meta({ id: 'x', name: 'Same', numFrames: 100 }),
    ];
    expect(sortAssets(tied, 'duration').map((a) => a.id)).toEqual(['x', 'y']);
    expect(sortAssets(tied, 'bpm').map((a) => a.id)).toEqual(['x', 'y']);
    expect(sortAssets(tied, 'loudness').map((a) => a.id)).toEqual(['x', 'y']);
  });
});

describe('referencedAssetIds', () => {
  it('collects assetIds from clips and ignores clips without one', () => {
    const ids = referencedAssetIds([{ assetId: 'a' }, {}, { assetId: 'b' }, { assetId: 'a' }]);
    expect([...ids].sort()).toEqual(['a', 'b']);
  });

  it('returns an empty set for no clips', () => {
    expect(referencedAssetIds([]).size).toBe(0);
  });

  it('collects assetIds held only by inactive comp takes', () => {
    const ids = referencedAssetIds([
      { assetId: 'active', takes: [{ assetId: 'active' }, { assetId: 'take2' }] },
    ]);
    expect([...ids].sort()).toEqual(['active', 'take2']);
  });

  it('collects assetIds held only by frozen tracks', () => {
    const ids = referencedAssetIds([], [{ frozen: { assetId: 'baked' } }, {}]);
    expect([...ids]).toEqual(['baked']);
  });

  it('combines clip, take and frozen references', () => {
    const ids = referencedAssetIds(
      [{ assetId: 'clip', takes: [{ assetId: 'take' }] }],
      [{ frozen: { assetId: 'frozen' } }],
    );
    expect([...ids].sort()).toEqual(['clip', 'frozen', 'take']);
  });
});
