import { describe, expect, it } from 'vitest';
import { parseMasteringSuggestion, suggestedPreset } from '@/ui/mastering/assistant';

/** A representative assistant JSON payload (subset of real fields). */
const SAMPLE = JSON.stringify({
  chainConfig: { version: 1, params: { limiterCeilingDb: -1 } },
  explanation: ['Loud, dense master', 'Bright spectral balance'],
  genreCandidates: [
    { name: 'edm', score: 0.82 },
    { name: 'pop', score: 0.41 },
  ],
  profile: {
    durationSec: 12.5,
    bpm: 128,
    bpmConfidence: 0.9,
    integratedLufs: -8.2,
    lraLu: 4.1,
    truePeakDb: -0.3,
    crestFactorDb: 7.5,
    spectralCentroidHz: 3200,
    spectralFlatness: 0.18,
    attackDensity: 0.6,
    sustainRatio: 0.4,
  },
});

describe('parseMasteringSuggestion', () => {
  it('extracts candidates, explanation and profile', () => {
    const result = parseMasteringSuggestion(SAMPLE);
    expect(result.genreCandidates).toEqual([
      { name: 'edm', score: 0.82 },
      { name: 'pop', score: 0.41 },
    ]);
    expect(result.explanation).toEqual(['Loud, dense master', 'Bright spectral balance']);
    expect(result.profile).toEqual({
      durationSec: 12.5,
      bpm: 128,
      bpmConfidence: 0.9,
      integratedLufs: -8.2,
      lraLu: 4.1,
      truePeakDb: -0.3,
      crestFactorDb: 7.5,
      spectralCentroidHz: 3200,
      spectralFlatness: 0.18,
      attackDensity: 0.6,
      sustainRatio: 0.4,
    });
  });

  it('returns an empty suggestion for unparseable or non-object input', () => {
    const empty = { genreCandidates: [], explanation: [], profile: null };
    expect(parseMasteringSuggestion('not json')).toEqual(empty);
    expect(parseMasteringSuggestion('42')).toEqual(empty);
    expect(parseMasteringSuggestion('null')).toEqual(empty);
  });

  it('tolerates missing fields and drops malformed entries', () => {
    const result = parseMasteringSuggestion(
      JSON.stringify({
        genreCandidates: [
          { name: 'jpop' }, // score missing -> 0
          { score: 1 }, // name missing -> dropped
          { name: '', score: 1 }, // empty name -> dropped
          'nope', // wrong type -> dropped
        ],
        explanation: ['ok', 5, null], // non-strings dropped
      }),
    );
    expect(result.genreCandidates).toEqual([{ name: 'jpop', score: 0 }]);
    expect(result.explanation).toEqual(['ok']);
    expect(result.profile).toBeNull();
  });

  it('coerces non-finite and missing profile numbers to 0', () => {
    const result = parseMasteringSuggestion(
      JSON.stringify({ profile: { bpm: 'x', integratedLufs: -9 } }),
    );
    expect(result.profile?.bpm).toBe(0);
    expect(result.profile?.integratedLufs).toBe(-9);
    expect(result.profile?.truePeakDb).toBe(0);
  });
});

describe('suggestedPreset', () => {
  it('picks the best candidate the catalog offers', () => {
    const result = parseMasteringSuggestion(SAMPLE);
    expect(suggestedPreset(result, ['pop', 'edm', 'jpop'])).toBe('edm');
  });

  it('skips candidates the catalog does not offer', () => {
    const result = parseMasteringSuggestion(SAMPLE);
    // 'edm' not offered -> fall through to 'pop'.
    expect(suggestedPreset(result, ['pop', 'classical'])).toBe('pop');
  });

  it('falls back to the top candidate when none are offered', () => {
    const result = parseMasteringSuggestion(SAMPLE);
    expect(suggestedPreset(result, [])).toBe('edm');
    expect(suggestedPreset(result, ['lofi'])).toBe('edm');
  });

  it('returns null when there are no candidates', () => {
    expect(suggestedPreset({ genreCandidates: [], explanation: [], profile: null }, ['pop'])).toBe(
      null,
    );
  });
});
