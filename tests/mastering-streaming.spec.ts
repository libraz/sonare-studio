import { describe, expect, it } from 'vitest';
import { parseStreamingPreview } from '@/ui/mastering/streaming';

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
