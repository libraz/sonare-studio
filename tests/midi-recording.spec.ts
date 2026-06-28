import { describe, expect, it } from 'vitest';
import type { NoteBoundaryEvent, RawNote } from '@/project/midi-events';
import { finalizeRecording, quantizeRecordedNotes } from '@/project/midi-recording';

/** A clip-relative note with neutral defaults. */
function note(over: Partial<RawNote> & Pick<RawNote, 'startPpq' | 'durationPpq'>): RawNote {
  return { pitch: 60, velocity: 100, channel: 0, ...over };
}

describe('quantizeRecordedNotes', () => {
  it('snaps starts to the nearest grid line and preserves length', () => {
    const out = quantizeRecordedNotes(
      [note({ startPpq: 1.4, durationPpq: 0.7 }), note({ startPpq: 0.1, durationPpq: 1 })],
      1,
    );
    expect(out).toEqual([
      note({ startPpq: 0, durationPpq: 1 }),
      note({ startPpq: 1, durationPpq: 0.7 }),
    ]);
  });

  it('never moves a start before zero and is a no-op for a non-positive grid', () => {
    expect(quantizeRecordedNotes([note({ startPpq: 0.2, durationPpq: 1 })], 1)).toEqual([
      note({ startPpq: 0, durationPpq: 1 }),
    ]);
    const original = [note({ startPpq: 0.37, durationPpq: 1 })];
    expect(quantizeRecordedNotes(original, 0)).toEqual(original);
  });
});

describe('finalizeRecording', () => {
  const boundaries: NoteBoundaryEvent[] = [
    { ppq: 4, kind: 'on', pitch: 60, velocity: 90, channel: 0 },
    { ppq: 6, kind: 'off', pitch: 60, velocity: 0, channel: 0 },
  ];

  it('offsets notes to the clip window and sizes the clip to the capture span', () => {
    const result = finalizeRecording(boundaries, { startPpq: 4, stopPpq: 12 });
    expect(result).toEqual({
      notes: [{ pitch: 60, velocity: 90, startPpq: 0, durationPpq: 2, channel: 0 }],
      lengthPpq: 8, // 12 - 4, longer than the last note end (2)
    });
  });

  it('extends the clip length to cover a note ringing past the punch-out', () => {
    const result = finalizeRecording(boundaries, { startPpq: 4, stopPpq: 5 });
    // The note ends at relative ppq 2, past the 1-beat capture window.
    expect(result?.lengthPpq).toBe(2);
  });

  it('applies the quantize grid to clip-relative starts', () => {
    const result = finalizeRecording(
      [
        { ppq: 4.4, kind: 'on', pitch: 62, velocity: 80, channel: 0 },
        { ppq: 5.4, kind: 'off', pitch: 62, velocity: 0, channel: 0 },
      ],
      { startPpq: 4, stopPpq: 8, gridPpq: 0.25 },
    );
    // Relative start 0.4 -> nearest 0.25 grid line = 0.5.
    expect(result?.notes[0].startPpq).toBe(0.5);
  });

  it('returns null when nothing usable was captured', () => {
    expect(finalizeRecording([], { startPpq: 0, stopPpq: 4 })).toBeNull();
    expect(
      finalizeRecording([{ ppq: 0, kind: 'on', pitch: 60, velocity: 90, channel: 0 }], {
        startPpq: 0,
        stopPpq: 4,
      }),
    ).toBeNull(); // unmatched note-on, no notes survive
  });
});
