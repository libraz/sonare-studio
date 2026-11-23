import { describe, expect, it } from 'vitest';
import type { NotatedMeasure, NotatedScore } from '@/notation/model';
import { harmonyXml } from '@/notation/musicxml-harmony';

const MEASURE: NotatedMeasure = {
  index: 0,
  startPpq: 0,
  lengthPpq: 4,
  timeSig: { beats: 4, beatUnit: 4 },
  voices: [],
};
const SCORE = { divisions: 480, parts: [] } as unknown as NotatedScore;

function degrees(quality: number, extensions: number[]): string[] {
  const xml = harmonyXml(
    { ppq: 0, text: '', rootPc: 0, quality, extensions },
    MEASURE,
    SCORE,
    0,
  ).join('');
  return [
    ...xml.matchAll(
      /<degree-value>(\d+)<\/degree-value><degree-alter>(-?\d+)<\/degree-alter><degree-type>(\w+)/g,
    ),
  ].map(([, value, alter, type]) => `${type} ${value}/${alter}`);
}

describe('MusicXML harmony degrees for an added chord tone', () => {
  it('writes an added major third on a suspended chord', () => {
    expect(degrees(8, [4])).toEqual(['add 3/0']);
  });

  it('writes an added perfect fifth on a diminished chord', () => {
    expect(degrees(2, [7])).toEqual(['add 5/0']);
  });
});
