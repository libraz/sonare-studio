import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotatedEvent, NotatedPart, NotatedScore } from '@/notation/model';
import { serializeMusicXml } from '@/notation/musicxml';

const eighth = { base: 'eighth', dots: 0 } as const;

function drumPart(id: string, count: number): NotatedPart {
  const events: NotatedEvent[] = Array.from({ length: count }, (_, i) => ({
    kind: 'note',
    pitches: [36 + (i % 4)],
    voice: 1,
    startPpq: i * 0.5,
    durationPpq: 0.5,
    value: eighth,
    tieStart: false,
    tieStop: false,
    midiChannels: [9],
  }));
  return {
    id,
    name: id,
    clef: 'treble',
    measures: [
      {
        index: 0,
        startPpq: 0,
        lengthPpq: count * 0.5,
        timeSig: { beats: count, beatUnit: 8 },
        voices: [{ voice: 1, events }],
      },
    ],
  };
}

describe('part instrument ids', () => {
  afterEach(() => vi.restoreAllMocks());

  it('tags notes with the owning part id without scanning the score per pitch', () => {
    const score: NotatedScore = {
      parts: [drumPart('P1', 40), drumPart('P2', 40)],
      keyFifths: 0,
      divisions: 960,
    };
    const spy = vi.spyOn(Array.prototype, 'includes');
    const xml = serializeMusicXml(score);
    const eventScans = spy.mock.contexts.filter(
      (ctx) => Array.isArray(ctx) && ctx.length > 0 && (ctx[0] as NotatedEvent)?.kind === 'note',
    ).length;
    expect(xml).toContain('<instrument id="P2-I36"/>');
    expect(xml).toContain('<instrument id="P1-I36"/>');
    expect(eventScans).toBe(0);
  });
});
