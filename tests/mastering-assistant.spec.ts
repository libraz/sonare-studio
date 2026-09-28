import { describe, expect, it } from 'vitest';
import { parseMasteringSuggestion, suggestedPresetOverrides } from '@/ui/mastering/assistant';

/** A representative assistant JSON payload (subset of real fields). */
const SAMPLE = JSON.stringify({
  chainConfig: { version: 1, params: { limiterCeilingDb: -1 } },
  explanation: ['Loud, dense master', 'Bright spectral balance'],
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
  it('extracts chain tuning, explanation and profile', () => {
    const result = parseMasteringSuggestion(SAMPLE);
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
    expect(result.chainParams).toEqual({ limiterCeilingDb: -1 });
    expect(result).not.toHaveProperty('genreCandidates');
  });

  it('returns an empty suggestion for unparseable or non-object input', () => {
    const empty = { explanation: [], profile: null, chainParams: null };
    expect(parseMasteringSuggestion('not json')).toEqual(empty);
    expect(parseMasteringSuggestion('42')).toEqual(empty);
    expect(parseMasteringSuggestion('null')).toEqual(empty);
  });

  it('tolerates missing fields and drops malformed chain values', () => {
    const result = parseMasteringSuggestion(
      JSON.stringify({
        chainConfig: { params: { enabled: true, gain: 1.5, invalid: 'nope' } },
        explanation: ['ok', 5, null], // non-strings dropped
      }),
    );
    expect(result.chainParams).toEqual({ enabled: true, gain: 1.5 });
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

describe('suggestedPresetOverrides', () => {
  it('keeps only the keys where the suggestion departs from the preset', () => {
    expect(
      suggestedPresetOverrides(
        {
          'loudness.targetLufs': -14,
          'loudness.ceilingDb': -1,
          'eq.tilt.enabled': true,
          'dynamics.compressor.ratio': 2.0000001,
        },
        {
          'loudness.targetLufs': -12,
          'loudness.ceilingDb': -1,
          'eq.tilt.enabled': false,
          'dynamics.compressor.ratio': 2,
        },
      ),
    ).toEqual({ 'loudness.targetLufs': -14, 'eq.tilt.enabled': true });
  });
});
