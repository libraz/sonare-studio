import { describe, expect, it } from 'vitest';
import type { NotatedMeasure, NotatedScore } from '@/notation/model';
import { serializeMusicXml } from '@/notation/musicxml';
import { applyLayoutBreaks } from '@/ui/score/use-score-notation';

/** Builds a score with `count` empty 4/4 measures. */
function scoreWithMeasures(count: number): NotatedScore {
  const measures: NotatedMeasure[] = Array.from({ length: count }, (_, index) => ({
    index,
    startPpq: index * 4,
    lengthPpq: 4,
    timeSig: { beats: 4, beatUnit: 4 },
    voices: [{ voice: 1, events: [] }],
  }));
  return {
    parts: [{ id: 'P1', name: 'Piano', clef: 'grand', measures }],
    keyFifths: 0,
    divisions: 960,
  };
}

describe('applyLayoutBreaks', () => {
  it('injects a system break every barsPerSystem measures', () => {
    const score = scoreWithMeasures(10);
    applyLayoutBreaks(score, [], 0, 4, { barsPerSystem: 4, barsPerPage: 16 });
    expect(score.measureBreaks).toEqual({ 4: 'system', 8: 'system' });
  });

  it('promotes a barsPerPage boundary to a page break', () => {
    const score = scoreWithMeasures(12);
    applyLayoutBreaks(score, [], 0, 4, { barsPerSystem: 4, barsPerPage: 8 });
    expect(score.measureBreaks).toEqual({ 4: 'system', 8: 'page' });
  });

  it('sets no breaks when barsPerSystem and barsPerPage are zero', () => {
    const score = scoreWithMeasures(10);
    applyLayoutBreaks(score, [], 0, 4, { barsPerSystem: 0, barsPerPage: 0 });
    expect(score.measureBreaks).toBeUndefined();
  });

  it('serializes injected system breaks as <print new-system>', () => {
    const score = scoreWithMeasures(10);
    applyLayoutBreaks(score, [], 0, 4, { barsPerSystem: 4, barsPerPage: 16 });
    const xml = serializeMusicXml(score);
    expect(xml).toContain('new-system="yes"');
  });
});
