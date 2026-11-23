import { describe, expect, it } from 'vitest';
import { serializeMusicXml } from '@/notation/musicxml';
import { quantizeToScore } from '@/notation/quantize';

describe('fingering on a tied note', () => {
  it('is written on the attack only, like the accidental', () => {
    // One whole note from beat 2 crosses the barline: two tied pieces, one key press.
    const xml = serializeMusicXml(
      quantizeToScore(
        [{ id: 1, pitch: 60, velocity: 96, startPpq: 2, durationPpq: 4, channel: 0 }],
        {
          divisionPpq: 0.25,
          timeSig: { beats: 4, beatUnit: 4 },
          keyFifths: 0,
          clipStartPpq: 0,
          clipLengthPpq: 8,
          clef: 'treble',
          estimateFingering: true,
        },
      ),
    );
    expect(xml.match(/<tied type="stop"\/>/g)).toHaveLength(1);
    expect(xml.match(/<fingering>/g)).toHaveLength(1);
  });
});
