import { describe, expect, it } from 'vitest';
import type { NoteBoundaryEvent, RawNote } from '@/project/midi-events';
import {
  finalizeRecording,
  foldRecordedNotesIntoLoop,
  lastCompleteLoopPassStartPpq,
  loopPassStartsWithEvents,
  quantizeRecordedNotes,
  selectLastCompleteLoopPassEvents,
  selectLastCompleteLoopPassNotes,
} from '@/project/midi-recording';

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

  it('applies shared strength and swing while leaving triplet grids ternary', () => {
    expect(
      quantizeRecordedNotes([note({ startPpq: 0.5, durationPpq: 1 })], 0.5, 0.5, 100)[0].startPpq,
    ).toBeCloseTo(0.5 + 0.5 / 6, 12);
    expect(
      quantizeRecordedNotes([note({ startPpq: 0.62, durationPpq: 1 })], 1 / 3, 1, 100)[0].startPpq,
    ).toBeCloseTo(2 / 3, 12);
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

describe('foldRecordedNotesIntoLoop', () => {
  it('wraps later passes into one loop-length overdub', () => {
    const out = foldRecordedNotesIntoLoop(
      [
        note({ pitch: 60, startPpq: 0.5, durationPpq: 1 }),
        note({ pitch: 64, startPpq: 4.25, durationPpq: 0.5 }),
      ],
      4,
    );
    expect(out).toEqual([
      note({ pitch: 64, startPpq: 0.25, durationPpq: 0.5 }),
      note({ pitch: 60, startPpq: 0.5, durationPpq: 1 }),
    ]);
  });

  it('splits notes that sustain across the loop boundary', () => {
    const out = foldRecordedNotesIntoLoop([note({ startPpq: 3.5, durationPpq: 1 })], 4);
    expect(out).toEqual([
      note({ startPpq: 0, durationPpq: 0.5 }),
      note({ startPpq: 3.5, durationPpq: 0.5 }),
    ]);
  });
});

describe('last loop pass selection', () => {
  it('groups captured event kinds into ordered loop-pass starts', () => {
    expect(
      loopPassStartsWithEvents(
        [{ ppq: 4.25 }, { ppq: 12.75 }, { ppq: 8.1 }, { ppq: 11.5 }, { ppq: 3.9 }],
        4,
        4,
      ),
    ).toEqual([4, 8, 12]);
  });

  it('rebases only the latest expression pass, including a final partial pass', () => {
    expect(lastCompleteLoopPassStartPpq(4, 14.5, 4)).toBe(12);
    const selected = selectLastCompleteLoopPassEvents(
      [
        { ppq: 7.5, value: 10 },
        { ppq: 11.5, value: 20 },
        { ppq: 12.5, value: 30 },
        { ppq: 14.2, value: 40 },
      ],
      4,
      14.5,
      4,
    );
    expect(selected).toHaveLength(2);
    expect(selected[0]).toEqual({ ppq: 4.5, value: 30 });
    expect(selected[1]?.ppq).toBeCloseTo(6.2, 9);
    expect(selected[1]?.value).toBe(40);
  });

  it('clips a sustained note to the selected pass instead of folding every pass together', () => {
    expect(
      selectLastCompleteLoopPassNotes([note({ startPpq: 6.5, durationPpq: 7 })], 4, 14.5, 4),
    ).toEqual([note({ startPpq: 0, durationPpq: 4 })]);
  });
});
