import { describe, expect, it } from 'vitest';
import type { NotatedScore } from '@/notation/model';
import { serializeMusicXml } from '@/notation/musicxml';
import { type QuantizeOptions, quantizeToScore } from '@/notation/quantize';
import { scoreClipWindow, scoreOnsetResolver } from '@/notation/score-clip-window';
import type { EditorNote } from '@/project/types';

function note(id: number, startPpq: number, durationPpq: number): EditorNote {
  return { id, pitch: 60, velocity: 96, startPpq, durationPpq, channel: 0 };
}

function options(overrides: Partial<QuantizeOptions>): QuantizeOptions {
  return {
    divisionPpq: 0.25,
    timeSig: { beats: 4, beatUnit: 4 },
    keyFifths: 0,
    clipStartPpq: 0,
    clipLengthPpq: 4,
    ...overrides,
  };
}

function noteOnsets(score: NotatedScore): number[] {
  return score.parts[0].measures.flatMap((measure) =>
    measure.voices.flatMap((voice) =>
      voice.events
        .filter((event) => event.kind === 'note' && !event.tieStop)
        .map((e) => e.startPpq),
    ),
  );
}

function measureSpans(score: NotatedScore): Array<[number, number]> {
  return score.parts[0].measures.map((measure) => [measure.startPpq, measure.lengthPpq]);
}

describe('score window edges', () => {
  it('ends a 7/8 bar on its barline on a triplet grid', () => {
    const score = quantizeToScore(
      [],
      options({ divisionPpq: 1 / 3, timeSig: { beats: 7, beatUnit: 8 }, clipLengthPpq: 3.5 }),
    );
    expect(measureSpans(score)).toEqual([[0, 3.5]]);
  });

  it('keeps a 3/8 bar whole on both the triplet and the quarter grid', () => {
    for (const divisionPpq of [1 / 3, 1]) {
      const score = quantizeToScore(
        [note(1, 0, 0.5)],
        options({ divisionPpq, timeSig: { beats: 3, beatUnit: 8 }, clipLengthPpq: 1.5 }),
      );
      expect(measureSpans(score)).toEqual([[0, 1.5]]);
    }
  });

  it('engraves a note in the last half step before the window end', () => {
    const score = quantizeToScore([note(1, 3.9, 0.1)], options({}));
    expect(measureSpans(score)).toEqual([[0, 4]]);
    expect(noteOnsets(score)).toEqual([3.75]);
    expect(serializeMusicXml(score).match(/<pitch>/g)).toHaveLength(1);
  });

  it('engraves a barline onset on the barline for a clip off the grid', () => {
    const score = quantizeToScore(
      [note(1, 4, 1)],
      options({ divisionPpq: 1 / 3, clipStartPpq: 0.5, clipLengthPpq: 7.5 }),
    );
    expect(noteOnsets(score)).toEqual([4]);
  });

  it('ends a pickup window on a barline after a later meter change', () => {
    const window = scoreClipWindow({
      clipStartPpq: 0,
      clipLengthPpq: 7,
      pickupLengthPpq: 1,
      timeSignatures: [
        { startPpq: 0, numerator: 4, denominator: 4 },
        { startPpq: 5, numerator: 3, denominator: 4 },
      ],
    });
    expect(window.clipLengthPpq).toBe(8);
  });

  it('gives click-to-note matching the onset the quantizer engraves', () => {
    const timeSignatures = [
      { startPpq: 0, numerator: 4, denominator: 4 },
      { startPpq: 8, numerator: 7, denominator: 8 },
    ];
    const cases = [
      { clipStartPpq: 0.5, clipLengthPpq: 12, pickupLengthPpq: 0, divisionPpq: 1 / 3 },
      { clipStartPpq: 0, clipLengthPpq: 9, pickupLengthPpq: 1, divisionPpq: 0.25 },
    ];
    for (const { divisionPpq, ...input } of cases) {
      const window = scoreClipWindow({ ...input, timeSignatures });
      const onsetOf = scoreOnsetResolver({ ...input, timeSignatures }, divisionPpq);
      for (const start of [0.6, 3.95, 4, 7.9, 8.2, 10.4, 11.4]) {
        const source = note(1, start, 0.2);
        const score = quantizeToScore(
          [source],
          options({
            divisionPpq,
            timeSig: window.timeSig,
            timeSignatures,
            clipStartPpq: input.clipStartPpq,
            clipLengthPpq: window.clipLengthPpq,
            pickupLengthPpq: input.pickupLengthPpq,
          }),
        );
        const engraved = noteOnsets(score);
        const onset = onsetOf(source);
        if (onset === null) expect(engraved).toEqual([]);
        else expect(engraved).toEqual([expect.closeTo(onset, 9)]);
      }
    }
  });
});
