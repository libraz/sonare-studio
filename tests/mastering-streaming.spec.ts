import type { MasteringStreamingPreviewResult } from '@libraz/libsonare';
import { describe, expect, it } from 'vitest';
import {
  invalidStreamingPlatformCount,
  normalizeStreamingPlatforms,
  streamingTargetsFromPreview,
  streamingTargetsFromReport,
} from '@/ui/mastering/streaming';

/** A representative streaming-preview result. */
const SAMPLE: MasteringStreamingPreviewResult = {
  platforms: [
    {
      name: 'Spotify',
      integratedLufs: -10.5,
      truePeakDbtp: -0.2,
      normalizationGainDb: -3.5,
      ceilingRisk: true,
    },
    {
      name: 'Apple Music',
      integratedLufs: -10.5,
      truePeakDbtp: -0.2,
      normalizationGainDb: -5.5,
      ceilingRisk: false,
    },
  ],
};

describe('streamingTargetsFromPreview', () => {
  it('extracts each platform verdict', () => {
    expect(streamingTargetsFromPreview(SAMPLE)).toEqual([
      {
        name: 'Spotify',
        integratedLufs: -10.5,
        truePeakDbtp: -0.2,
        normalizationGainDb: -3.5,
        ceilingRisk: true,
      },
      {
        name: 'Apple Music',
        integratedLufs: -10.5,
        truePeakDbtp: -0.2,
        normalizationGainDb: -5.5,
        ceilingRisk: false,
      },
    ]);
  });

  it('returns an empty list for a result without platforms', () => {
    expect(streamingTargetsFromPreview({ platforms: [] })).toEqual([]);
  });

  it('preserves measured silence and an absent normalization gain', () => {
    expect(
      streamingTargetsFromPreview({
        platforms: [
          {
            name: 'Spotify',
            integratedLufs: Number.NEGATIVE_INFINITY,
            truePeakDbtp: Number.NEGATIVE_INFINITY,
            ceilingRisk: false,
          },
        ],
      }),
    ).toStrictEqual([
      {
        name: 'Spotify',
        integratedLufs: Number.NEGATIVE_INFINITY,
        truePeakDbtp: Number.NEGATIVE_INFINITY,
        ceilingRisk: false,
      },
    ]);
  });

  it('drops entries without a name and preserves platforms with no gain', () => {
    const result = streamingTargetsFromPreview({
      platforms: [
        {
          name: '',
          integratedLufs: -14,
          truePeakDbtp: -1,
          normalizationGainDb: 0,
          ceilingRisk: false,
        },
        {
          name: 'YouTube',
          integratedLufs: Number.NEGATIVE_INFINITY,
          truePeakDbtp: -3,
          ceilingRisk: false,
        },
      ],
    });
    expect(result).toEqual([
      {
        name: 'YouTube',
        integratedLufs: Number.NEGATIVE_INFINITY,
        truePeakDbtp: -3,
        ceilingRisk: false,
      },
    ]);
  });
});

describe('streaming target helpers', () => {
  it('normalizes editable platform configs before calling wasm', () => {
    expect(
      normalizeStreamingPlatforms([
        { name: '  Bandcamp  ', targetLufs: -18, ceilingDbtp: -2 },
        { name: '', targetLufs: -14, ceilingDbtp: -1 },
        { name: 'Too Loud', targetLufs: 3, ceilingDbtp: -1 },
        { name: 'Bad Ceiling', targetLufs: -14, ceilingDbtp: -99 },
      ]),
    ).toEqual([{ name: 'Bandcamp', targetLufs: -18, ceilingDbtp: -2 }]);
  });

  it('identifies invalid editor rows without silently submitting a subset', () => {
    expect(
      invalidStreamingPlatformCount([
        { name: 'Bandcamp', targetLufs: -18, ceilingDbtp: -2 },
        { name: '', targetLufs: -14, ceilingDbtp: -1 },
      ]),
    ).toBe(1);
  });

  it('computes platform verdicts from the panel mixdown report', () => {
    expect(
      streamingTargetsFromReport(
        {
          peakDb: -1,
          truePeakDbtp: -0.5,
          lufs: -14,
        },
        [
          { name: 'Spotify', targetLufs: -14, ceilingDbtp: -1 },
          { name: 'Bandcamp', targetLufs: -18, ceilingDbtp: -2 },
        ],
      ),
    ).toEqual([
      {
        name: 'Spotify',
        integratedLufs: -14,
        truePeakDbtp: -0.5,
        normalizationGainDb: 0,
        ceilingRisk: true,
      },
      {
        name: 'Bandcamp',
        integratedLufs: -14,
        truePeakDbtp: -0.5,
        normalizationGainDb: -4,
        ceilingRisk: false,
      },
    ]);
  });

  it('returns null when the mixdown report has no loudness', () => {
    expect(
      streamingTargetsFromReport({ peakDb: -1 }, [
        { name: 'Spotify', targetLufs: -14, ceilingDbtp: -1 },
      ]),
    ).toBeNull();
  });

  it('requires measured true peak instead of relabeling sample peak as dBTP', () => {
    expect(
      streamingTargetsFromReport({ peakDb: -1, lufs: -14 }, [
        { name: 'Spotify', targetLufs: -14, ceilingDbtp: -1 },
      ]),
    ).toBeNull();
  });

  it('keeps a silent report measured and leaves normalization gain absent', () => {
    const targets = streamingTargetsFromReport(
      {
        peakDb: Number.NEGATIVE_INFINITY,
        truePeakDbtp: Number.NEGATIVE_INFINITY,
        lufs: Number.NEGATIVE_INFINITY,
      },
      [{ name: 'Spotify', targetLufs: -14, ceilingDbtp: -1 }],
    );
    expect(targets).toEqual([
      {
        name: 'Spotify',
        integratedLufs: Number.NEGATIVE_INFINITY,
        truePeakDbtp: Number.NEGATIVE_INFINITY,
        ceilingRisk: false,
      },
    ]);
    expect(targets?.[0]).not.toHaveProperty('normalizationGainDb');
  });

  it('treats absent true peak differently from measured silent true peak', () => {
    const platforms = [{ name: 'Spotify', targetLufs: -14, ceilingDbtp: -1 }];
    expect(
      streamingTargetsFromReport(
        { peakDb: Number.NEGATIVE_INFINITY, lufs: Number.NEGATIVE_INFINITY },
        platforms,
      ),
    ).toBeNull();
    expect(
      streamingTargetsFromReport(
        {
          peakDb: Number.NEGATIVE_INFINITY,
          lufs: Number.NEGATIVE_INFINITY,
          truePeakDbtp: Number.NEGATIVE_INFINITY,
        },
        platforms,
      ),
    ).toEqual([
      {
        name: 'Spotify',
        integratedLufs: Number.NEGATIVE_INFINITY,
        truePeakDbtp: Number.NEGATIVE_INFINITY,
        ceilingRisk: false,
      },
    ]);
  });
});
