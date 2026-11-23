import { describe, expect, it } from 'vitest';
import type { NotatedEvent, NotatedScore } from '@/notation/model';
import { buildBeamIndex } from '@/notation/musicxml-beams';
import { type QuantizeOptions, quantizeToScore } from '@/notation/quantize';
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
    clipLengthPpq: 8,
    ...overrides,
  };
}

function pickupEvents(score: NotatedScore): NotatedEvent[] {
  return score.parts[0].measures[0].voices[0].events;
}

function shape(events: ReadonlyArray<NotatedEvent>): string[] {
  return events.map(
    (event) => `${event.kind}@${event.startPpq}:${event.value.base}${'.'.repeat(event.value.dots)}`,
  );
}

describe('a pickup measure counts its beats back from the barline it ends on', () => {
  it('splits a pickup rest at the beat the bar would have, not one beat after the pickup starts', () => {
    // A 1.5-beat pickup in 4/4 is beats 3.5-5 of a full bar: the beat falls at 0.5.
    const score = quantizeToScore(
      [note(1, 1, 0.5)],
      options({ clipLengthPpq: 5.5, pickupLengthPpq: 1.5 }),
    );
    expect(shape(pickupEvents(score))).toEqual([
      'rest@0:eighth',
      'rest@0.5:eighth',
      'note@1:eighth',
    ]);
  });

  it('beams a pickup by the beats of the full bar', () => {
    const score = quantizeToScore(
      [note(1, 0, 0.5), note(2, 0.5, 0.5), note(3, 1, 0.5)],
      options({ clipLengthPpq: 5.5, pickupLengthPpq: 1.5 }),
    );
    const measure = score.parts[0].measures[0];
    const beams = buildBeamIndex(measure.voices[0], measure, undefined);
    expect(pickupEvents(score).map((event) => beams.get(event)?.[0] ?? 'flag')).toEqual([
      'flag',
      'begin',
      'end',
    ]);
  });

  it('beams a compound-meter pickup across its dotted beat from the end', () => {
    // Four eighths of 6/8 before the barline: one, then a full dotted beat of three.
    const score = quantizeToScore(
      [note(1, 0, 0.5), note(2, 0.5, 0.5), note(3, 1, 0.5), note(4, 1.5, 0.5)],
      options({ timeSig: { beats: 6, beatUnit: 8 }, clipLengthPpq: 5, pickupLengthPpq: 2 }),
    );
    const measure = score.parts[0].measures[0];
    const beams = buildBeamIndex(measure.voices[0], measure, undefined);
    expect(pickupEvents(score).map((event) => beams.get(event)?.[0] ?? 'flag')).toEqual([
      'flag',
      'begin',
      'continue',
      'end',
    ]);
  });
});
