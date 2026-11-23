import { describe, expect, it } from 'vitest';
import { serializeMusicXml } from '@/notation/musicxml';
import { quantizeToScore } from '@/notation/quantize';

describe('grand-staff rest staff assignment', () => {
  it('writes the silent lower hand rest voice on the bass staff', () => {
    const score = quantizeToScore(
      [{ id: 1, pitch: 72, velocity: 96, startPpq: 0, durationPpq: 4, channel: 0 }],
      {
        divisionPpq: 1,
        timeSig: { beats: 4, beatUnit: 4 },
        keyFifths: 0,
        clipStartPpq: 0,
        clipLengthPpq: 4,
        clef: 'grand',
      },
    );
    const doc = new DOMParser().parseFromString(serializeMusicXml(score), 'application/xml');
    const lowerRests = [...doc.querySelectorAll('part[id="P1"] > measure > note')].filter(
      (n) => n.querySelector('rest') !== null && n.querySelector('voice')?.textContent === '3',
    );

    expect(lowerRests.length).toBeGreaterThan(0);
    expect(lowerRests.map((n) => n.querySelector('staff')?.textContent)).toEqual(
      lowerRests.map(() => '2'),
    );
  });
});
