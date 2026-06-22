import { describe, expect, it } from 'vitest';
import {
  parseMatchEqCurve,
  parseReferenceLoudness,
  parseTonalBalance,
} from '@/ui/sample-editor/match-eq-analysis';

describe('parseMatchEqCurve', () => {
  it('zips frequencies and gains to their common length', () => {
    const curve = parseMatchEqCurve('{"frequencies":[100,1000,10000],"gainDb":[1,-2,3]}');
    expect(curve).toEqual({ frequencies: [100, 1000, 10000], gainDb: [1, -2, 3] });
  });

  it('drops pairs with a non-finite value and trims to the shorter array', () => {
    const curve = parseMatchEqCurve('{"frequencies":[100,200,300],"gainDb":[1,null]}');
    expect(curve).toEqual({ frequencies: [100], gainDb: [1] });
  });

  it('returns empty arrays on malformed or missing input', () => {
    expect(parseMatchEqCurve('not json')).toEqual({ frequencies: [], gainDb: [] });
    expect(parseMatchEqCurve('{"frequencies":[100]}')).toEqual({ frequencies: [], gainDb: [] });
    expect(parseMatchEqCurve('42')).toEqual({ frequencies: [], gainDb: [] });
  });
});

describe('parseTonalBalance', () => {
  it('reads the band fields', () => {
    const bands = parseTonalBalance(
      '{"bands":[{"lowHz":20,"highHz":200,"sourceDb":-10,"referenceDb":-12,"deviationDb":2}]}',
    );
    expect(bands).toEqual([
      { lowHz: 20, highHz: 200, sourceDb: -10, referenceDb: -12, deviationDb: 2 },
    ]);
  });

  it('coerces missing numeric fields to 0 and drops non-object bands', () => {
    const bands = parseTonalBalance('{"bands":[{"lowHz":20},5,null]}');
    expect(bands).toEqual([{ lowHz: 20, highHz: 0, sourceDb: 0, referenceDb: 0, deviationDb: 0 }]);
  });

  it('returns an empty array on malformed or missing bands', () => {
    expect(parseTonalBalance('nope')).toEqual([]);
    expect(parseTonalBalance('{"bands":42}')).toEqual([]);
    expect(parseTonalBalance('{}')).toEqual([]);
  });
});

describe('parseReferenceLoudness', () => {
  it('reads the loudness fields', () => {
    const loudness = parseReferenceLoudness(
      '{"sourceLufs":-14,"referenceLufs":-9,"gainToMatchDb":5}',
    );
    expect(loudness).toEqual({ sourceLufs: -14, referenceLufs: -9, gainToMatchDb: 5 });
  });

  it('coerces missing fields to 0', () => {
    expect(parseReferenceLoudness('{"sourceLufs":-14}')).toEqual({
      sourceLufs: -14,
      referenceLufs: 0,
      gainToMatchDb: 0,
    });
  });

  it('returns null on malformed input', () => {
    expect(parseReferenceLoudness('not json')).toBeNull();
    expect(parseReferenceLoudness('null')).toBeNull();
  });
});
