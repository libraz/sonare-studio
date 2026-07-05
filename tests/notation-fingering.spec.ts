import { describe, expect, it } from 'vitest';
import type { NotatedEvent, NotatedScore } from '@/notation/model';
import { serializeMusicXml } from '@/notation/musicxml';
import { type QuantizeOptions, quantizeToScore } from '@/notation/quantize';
import type { EditorNote } from '@/project/types';

/** Builds a monophonic stream of quarter notes, one per pitch, starting at beat 0. */
function melody(pitches: number[], durationPpq = 1): EditorNote[] {
  return pitches.map((pitch, index) => ({
    id: index + 1,
    pitch,
    velocity: 96,
    startPpq: index * durationPpq,
    durationPpq,
    channel: 0,
  }));
}

/** Builds simultaneous notes forming one chord at beat 0. */
function chord(pitches: number[], durationPpq = 4): EditorNote[] {
  return pitches.map((pitch, index) => ({
    id: index + 1,
    pitch,
    velocity: 96,
    startPpq: 0,
    durationPpq,
    channel: 0,
  }));
}

/** Base options: 16th grid, 4/4, C major, two measures (0..8). */
function baseOptions(overrides: Partial<QuantizeOptions> = {}): QuantizeOptions {
  return {
    divisionPpq: 0.25,
    timeSig: { beats: 4, beatUnit: 4 },
    keyFifths: 0,
    clipStartPpq: 0,
    clipLengthPpq: 8,
    ...overrides,
  };
}

/** Collects note events across the whole score in engraved order. */
function noteEvents(score: NotatedScore): NotatedEvent[] {
  const events: NotatedEvent[] = [];
  for (const part of score.parts) {
    for (const measure of part.measures) {
      for (const voice of measure.voices) {
        for (const event of voice.events) {
          if (event.kind === 'note') events.push(event);
        }
      }
    }
  }
  return events;
}

describe('quantizeToScore fingering estimation', () => {
  it('fingers a right-hand ascending octave scale with a thumb-under', () => {
    // C major scale C4..C5.
    const score = quantizeToScore(melody([60, 62, 64, 65, 67, 69, 71, 72]), {
      ...baseOptions(),
      clef: 'treble',
      estimateFingering: true,
    });
    const fingers = noteEvents(score).map((event) => event.fingering?.[0]);
    expect(fingers).toEqual([1, 2, 3, 1, 2, 3, 4, 5]);
  });

  it('fingers a left-hand descending octave scale', () => {
    // C major scale C4..C3, descending.
    const score = quantizeToScore(melody([60, 59, 57, 55, 53, 52, 50, 48]), {
      ...baseOptions(),
      clef: 'bass',
      estimateFingering: true,
    });
    const fingers = noteEvents(score).map((event) => event.fingering?.[0]);
    expect(fingers).toEqual([1, 2, 3, 1, 2, 3, 4, 5]);
  });

  it('spreads a right-hand triad thumb-to-pinky', () => {
    const score = quantizeToScore(chord([60, 64, 67]), {
      ...baseOptions(),
      clef: 'treble',
      estimateFingering: true,
    });
    const [event] = noteEvents(score);
    expect(event.pitches).toEqual([60, 64, 67]);
    expect(event.fingering).toEqual([1, 3, 5]);
  });

  it('mirrors a left-hand triad thumb-to-pinky', () => {
    const score = quantizeToScore(chord([48, 52, 55]), {
      ...baseOptions(),
      clef: 'bass',
      estimateFingering: true,
    });
    const [event] = noteEvents(score);
    expect(event.pitches).toEqual([48, 52, 55]);
    expect(event.fingering).toEqual([5, 3, 1]);
  });

  it('flags a hand cross when the left hand reaches above the split', () => {
    // A left-hand line rising through middle C stays on the bass staff.
    const score = quantizeToScore(melody([55, 57, 59, 60, 62]), {
      ...baseOptions(),
      clef: 'grand',
      estimateFingering: true,
    });
    const crossing = noteEvents(score).filter((event) => event.handCross === true);
    expect(crossing.map((event) => event.pitches[0])).toEqual([60, 62]);
    for (const event of crossing) {
      // The crossing notes sound above the split yet engrave on the bass staff.
      expect(event.staff).toBe(2);
      expect(event.pitches[0]).toBeGreaterThanOrEqual(60);
    }
  });

  it('leaves fingering and hand-cross absent by default', () => {
    const score = quantizeToScore(melody([60, 62, 64, 65, 67, 69, 71, 72]), {
      ...baseOptions(),
      clef: 'grand',
    });
    for (const event of noteEvents(score)) {
      expect(event.fingering).toBeUndefined();
      expect(event.handCross).toBeUndefined();
    }
  });
});

describe('serializeMusicXml fingering', () => {
  it('emits <fingering> only when fingering estimation is enabled', () => {
    const notes = melody([60, 62, 64, 65, 67, 69, 71, 72]);
    const options = baseOptions({ clef: 'treble' });

    const withFingering = serializeMusicXml(
      quantizeToScore(notes, { ...options, estimateFingering: true }),
    );
    expect(withFingering).toContain('<technical><fingering>1</fingering></technical>');
    expect(withFingering).toContain('<technical><fingering>5</fingering></technical>');

    const withoutFingering = serializeMusicXml(quantizeToScore(notes, options));
    expect(withoutFingering).not.toContain('<fingering>');
  });

  it('emits one <fingering> per chord note', () => {
    const xml = serializeMusicXml(
      quantizeToScore(chord([60, 64, 67]), {
        ...baseOptions(),
        clef: 'treble',
        estimateFingering: true,
      }),
    );
    const fingerings = xml.match(/<fingering>\d<\/fingering>/g) ?? [];
    expect(fingerings).toEqual([
      '<fingering>1</fingering>',
      '<fingering>3</fingering>',
      '<fingering>5</fingering>',
    ]);
  });
});
