import { describe, expect, it } from 'vitest';
import { analyzeMatchEqToReference } from '@/ui/sample-editor/wasm-ops';
import { analyzePairFn, pairAnalysisResults } from './fakes/analysis';

describe('Match EQ analysis without a normalization gain', () => {
  it('retains both measured loudness values when gain is absent', () => {
    const expected = { sourceLufs: Number.NEGATIVE_INFINITY, referenceLufs: -20.2 };
    const result = analyzeMatchEqToReference(
      {
        masteringAnalyzePair: analyzePairFn(
          pairAnalysisResults({ 'match.referenceLoudness': expected }),
        ),
      },
      [new Float32Array([0, 0])],
      48000,
      new Float32Array([0.5, -0.5]),
    );

    expect(result.loudness).toStrictEqual(expected);
    expect('gainToMatchDb' in result.loudness).toBe(false);
  });
});
