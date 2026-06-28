import { describe, expect, it } from 'vitest';
import { type NoteBoundaryEvent, pairNoteBoundariesIntoNotes } from '@/project/midi-events';

/** Builds a note boundary with neutral defaults. */
function boundary(
  over: Partial<NoteBoundaryEvent> & Pick<NoteBoundaryEvent, 'ppq' | 'kind'>,
): NoteBoundaryEvent {
  return { channel: 0, pitch: 60, velocity: 100, ...over };
}

describe('pairNoteBoundariesIntoNotes', () => {
  it('pairs on/off boundaries into notes carrying velocity and length', () => {
    const notes = pairNoteBoundariesIntoNotes([
      boundary({ ppq: 0, kind: 'on', pitch: 60, velocity: 96 }),
      boundary({ ppq: 2, kind: 'off', pitch: 60, velocity: 40 }),
    ]);
    expect(notes).toEqual([
      { pitch: 60, velocity: 96, startPpq: 0, durationPpq: 2, channel: 0, offVelocity: 40 },
    ]);
  });

  it('sorts unsorted input and pairs back-to-back repeats of the same pitch FIFO', () => {
    // Off sorts before on at the same PPQ so the first note releases before the
    // repeat retriggers. Input deliberately out of order.
    const notes = pairNoteBoundariesIntoNotes([
      boundary({ ppq: 1, kind: 'on', pitch: 64, velocity: 80 }),
      boundary({ ppq: 0, kind: 'on', pitch: 64, velocity: 70 }),
      boundary({ ppq: 2, kind: 'off', pitch: 64, velocity: 0 }),
      boundary({ ppq: 1, kind: 'off', pitch: 64, velocity: 0 }),
    ]);
    expect(notes).toEqual([
      { pitch: 64, velocity: 70, startPpq: 0, durationPpq: 1, channel: 0 },
      { pitch: 64, velocity: 80, startPpq: 1, durationPpq: 1, channel: 0 },
    ]);
  });

  it('drops unmatched note-ons and zero/negative-length pairs', () => {
    const notes = pairNoteBoundariesIntoNotes([
      boundary({ ppq: 0, kind: 'on', pitch: 60 }),
      boundary({ ppq: 0, kind: 'off', pitch: 60 }), // zero length -> dropped
      boundary({ ppq: 1, kind: 'on', pitch: 62 }), // never released -> dropped
    ]);
    expect(notes).toEqual([]);
  });

  it('keeps notes on distinct channels independent', () => {
    const notes = pairNoteBoundariesIntoNotes([
      boundary({ ppq: 0, kind: 'on', pitch: 60, channel: 0 }),
      boundary({ ppq: 0, kind: 'on', pitch: 60, channel: 1 }),
      boundary({ ppq: 4, kind: 'off', pitch: 60, channel: 1, velocity: 0 }),
      boundary({ ppq: 2, kind: 'off', pitch: 60, channel: 0, velocity: 0 }),
    ]);
    expect(notes).toEqual([
      { pitch: 60, velocity: 100, startPpq: 0, durationPpq: 2, channel: 0 },
      { pitch: 60, velocity: 100, startPpq: 0, durationPpq: 4, channel: 1 },
    ]);
  });
});
