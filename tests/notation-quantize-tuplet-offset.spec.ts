import { describe, expect, it } from 'vitest';
import { quantizeToScore } from '@/notation/quantize';
import type { EditorNote } from '@/project/types';

function note(id: number, pitch: number, startPpq: number, durationPpq: number): EditorNote {
  return { id, pitch, velocity: 96, startPpq, durationPpq, channel: 0 };
}

function quantizeTriplet(): ReturnType<typeof quantizeToScore> {
  return quantizeToScore([note(1, 60, 0, 1 / 3), note(2, 62, 1 / 3, 1)], {
    divisionPpq: 1 / 3,
    timeSig: { beats: 4, beatUnit: 4 },
    keyFifths: 0,
    clipStartPpq: 0,
    clipLengthPpq: 4,
  });
}

describe('tuplet offsets', () => {
  it('splits a note starting at a triplet offset into tuplet values at the beat', () => {
    const events = quantizeTriplet().parts[0].measures[0].voices[0].events;
    const notes = events.filter((event) => event.kind === 'note');
    expect(notes.map((event) => event.startPpq)).toEqual([
      0,
      expect.closeTo(1 / 3, 9),
      expect.closeTo(1, 9),
    ]);
    for (const event of notes) expect(event.value.tuplet).toEqual({ actual: 3, normal: 2 });
  });

  it('keeps every tuplet group a whole number of triplet eighths', () => {
    const events = quantizeTriplet().parts[0].measures[0].voices[0].events;
    const groups = new Map<string, number>();
    for (const event of events) {
      if (event.tupletGroupId === undefined) continue;
      groups.set(event.tupletGroupId, (groups.get(event.tupletGroupId) ?? 0) + event.durationPpq);
    }
    expect(groups.size).toBeGreaterThan(0);
    for (const total of groups.values()) expect(total).toBeCloseTo(1, 9);
  });
});
