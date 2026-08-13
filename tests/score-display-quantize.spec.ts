import { describe, expect, it } from 'vitest';
import {
  SCORE_DISPLAY_QUANTIZE_DIVISION_PPQ,
  type ScoreDisplayQuantizeKey,
} from '@/project/annotations';

/** The stable order used by the score toolbar's select menu. */
const DISPLAY_QUANTIZE_KEYS: ReadonlyArray<ScoreDisplayQuantizeKey> = [
  '4',
  '8',
  '16',
  '32',
  '8t',
  '16t',
];

describe('score display quantize catalog', () => {
  it('keeps every typed key mapped to a positive PPQ division', () => {
    expect(Object.keys(SCORE_DISPLAY_QUANTIZE_DIVISION_PPQ)).toEqual(DISPLAY_QUANTIZE_KEYS);
    for (const key of DISPLAY_QUANTIZE_KEYS) {
      expect(SCORE_DISPLAY_QUANTIZE_DIVISION_PPQ[key]).toBeGreaterThan(0);
    }
  });
});
