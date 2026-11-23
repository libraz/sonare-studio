import { describe, expect, it } from 'vitest';
import { serializeMusicXml } from '@/notation/musicxml';
import { importMusicXml } from '@/notation/musicxml-import';
import { quantizeToScore } from '@/notation/quantize';

describe('MusicXML round trip of a meter change inside a bar', () => {
  it('keeps notes and the new meter where they were after the shortened bar', () => {
    // 4/4 with a change to 3/4 at beat 6: bar 2 is cut to two beats.
    const score = quantizeToScore(
      [
        { id: 1, pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 },
        { id: 2, pitch: 64, velocity: 96, startPpq: 4, durationPpq: 1, channel: 0 },
        { id: 3, pitch: 67, velocity: 96, startPpq: 6, durationPpq: 1, channel: 0 },
        { id: 4, pitch: 72, velocity: 96, startPpq: 9, durationPpq: 1, channel: 0 },
      ],
      {
        divisionPpq: 1,
        timeSig: { beats: 4, beatUnit: 4 },
        timeSignatures: [{ startPpq: 6, numerator: 3, denominator: 4 }],
        keyFifths: 0,
        clipStartPpq: 0,
        clipLengthPpq: 12,
      },
    );
    expect(score.parts[0].measures.map((measure) => measure.lengthPpq)).toEqual([4, 2, 3, 3]);

    const doc = importMusicXml(serializeMusicXml(score));

    expect(doc.tracks[0].clips[0].notes.map((note) => note.startPpq)).toEqual([0, 4, 6, 9]);
    expect(
      doc.timeSignatures.map((change) => [change.startPpq, change.numerator, change.denominator]),
    ).toContainEqual([6, 3, 4]);
  });
});
