import { describe, expect, it } from 'vitest';
import {
  normalizeStreamingPlatforms,
  parseStreamingPreview,
  streamingTargetsFromReport,
} from '@/ui/mastering/streaming';

/** A representative streaming-preview payload. */
const SAMPLE = JSON.stringify({
  platforms: [
    {
      name: 'Spotify',
      integratedLufs: -10.5,
      truePeakDb: -0.2,
      normalizationGainDb: -3.5,
      ceilingRisk: true,
    },
    {
      name: 'Apple Music',
      integratedLufs: -10.5,
      truePeakDb: -0.2,
      normalizationGainDb: -5.5,
      ceilingRisk: false,
    },
  ],
});

describe('parseStreamingPreview', () => {
  it('extracts each platform verdict', () => {
    expect(parseStreamingPreview(SAMPLE)).toEqual([
      {
        name: 'Spotify',
        integratedLufs: -10.5,
        truePeakDb: -0.2,
        normalizationGainDb: -3.5,
        ceilingRisk: true,
      },
      {
        name: 'Apple Music',
        integratedLufs: -10.5,
        truePeakDb: -0.2,
        normalizationGainDb: -5.5,
        ceilingRisk: false,
      },
    ]);
  });

  it('returns an empty list for unparseable, non-object, or platform-less input', () => {
    expect(parseStreamingPreview('not json')).toEqual([]);
    expect(parseStreamingPreview('42')).toEqual([]);
    expect(parseStreamingPreview('null')).toEqual([]);
    expect(parseStreamingPreview(JSON.stringify({ platforms: 'nope' }))).toEqual([]);
  });

  it('drops entries without a name and coerces missing numbers to 0', () => {
    const result = parseStreamingPreview(
      JSON.stringify({
        platforms: [
          { integratedLufs: -14 }, // no name -> dropped
          { name: '', integratedLufs: -14 }, // empty name -> dropped
          'nope', // wrong type -> dropped
          { name: 'YouTube', truePeakDb: 'x' }, // bad number -> 0
        ],
      }),
    );
    expect(result).toEqual([
      {
        name: 'YouTube',
        integratedLufs: 0,
        truePeakDb: 0,
        normalizationGainDb: 0,
        ceilingRisk: false,
      },
    ]);
  });

  it('treats a non-true ceilingRisk as false', () => {
    const result = parseStreamingPreview(
      JSON.stringify({ platforms: [{ name: 'Tidal', ceilingRisk: 'yes' }] }),
    );
    expect(result[0].ceilingRisk).toBe(false);
  });
});

describe('streaming target helpers', () => {
  it('normalizes editable platform configs before calling wasm', () => {
    expect(
      normalizeStreamingPlatforms([
        { name: '  Bandcamp  ', targetLufs: -18, ceilingDb: -2 },
        { name: '', targetLufs: -14, ceilingDb: -1 },
        { name: 'Too Loud', targetLufs: 3, ceilingDb: -1 },
        { name: 'Bad Ceiling', targetLufs: -14, ceilingDb: -99 },
      ]),
    ).toEqual([{ name: 'Bandcamp', targetLufs: -18, ceilingDb: -2 }]);
  });

  it('computes platform verdicts from the panel mixdown report', () => {
    expect(
      streamingTargetsFromReport(
        {
          peakDb: -1,
          truePeakDb: -0.5,
          lufs: -14,
        },
        [
          { name: 'Spotify', targetLufs: -14, ceilingDb: -1 },
          { name: 'Bandcamp', targetLufs: -18, ceilingDb: -2 },
        ],
      ),
    ).toEqual([
      {
        name: 'Spotify',
        integratedLufs: -14,
        truePeakDb: -0.5,
        normalizationGainDb: 0,
        ceilingRisk: true,
      },
      {
        name: 'Bandcamp',
        integratedLufs: -14,
        truePeakDb: -0.5,
        normalizationGainDb: -4,
        ceilingRisk: false,
      },
    ]);
  });

  it('returns null when the mixdown report has no loudness', () => {
    expect(
      streamingTargetsFromReport({ peakDb: -1 }, [
        { name: 'Spotify', targetLufs: -14, ceilingDb: -1 },
      ]),
    ).toBeNull();
  });
});
