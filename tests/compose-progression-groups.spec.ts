import { describe, expect, it } from 'vitest';
import { detectProgressionGroups } from '@/compose/progression-groups';
import type { EditorChordSymbol } from '@/project/chords';

/** One-bar chord symbol at bar `bar` (1-based), 4 PPQ per bar. */
function bar(bar: number, rootPc: number, quality = 0): EditorChordSymbol {
  return { startPpq: (bar - 1) * 4, endPpq: bar * 4, rootPc, quality };
}

describe('detectProgressionGroups', () => {
  it('finds a 4-chord pattern repeating three times with a partial trailing repeat', () => {
    const chords = [
      bar(1, 0),
      bar(2, 7),
      bar(3, 9, 1),
      bar(4, 5),
      bar(5, 0),
      bar(6, 7),
      bar(7, 9, 1),
      bar(8, 5),
      bar(9, 0),
      bar(10, 7),
      bar(11, 9, 1),
      bar(12, 5),
      bar(13, 0),
    ];

    const groups = detectProgressionGroups(chords);

    expect(groups).toEqual([
      { startIndex: 0, period: 4, repeatCount: 3, length: 13, partialTrailingRepeat: true },
    ]);
  });

  it('does not group a run that only repeats once', () => {
    const chords = [bar(1, 0), bar(2, 7), bar(3, 0), bar(4, 7)];
    expect(detectProgressionGroups(chords)).toEqual([
      { startIndex: 0, period: 2, repeatCount: 2, length: 4, partialTrailingRepeat: false },
    ]);
  });

  it('finds nothing in a non-repeating progression', () => {
    const chords = [bar(1, 0), bar(2, 2), bar(3, 5), bar(4, 9)];
    expect(detectProgressionGroups(chords)).toEqual([]);
  });

  it('treats a different slash bass as a different slot', () => {
    const withBass: EditorChordSymbol = { ...bar(3, 0), bassPc: 4 };
    const chords = [bar(1, 0), bar(2, 7), withBass, bar(4, 7)];
    expect(detectProgressionGroups(chords)).toEqual([]);
  });

  it('treats a different duration as a different slot', () => {
    const shorter: EditorChordSymbol = { startPpq: 4, endPpq: 6, rootPc: 7, quality: 0 };
    const chords = [bar(1, 0), shorter, bar(2, 0), bar(3, 7)];
    expect(detectProgressionGroups(chords)).toEqual([]);
  });

  it('groups two adjacent independent patterns separately', () => {
    const chords = [
      bar(1, 0),
      bar(2, 7),
      bar(3, 0),
      bar(4, 7),
      bar(5, 5),
      bar(6, 2),
      bar(7, 5),
      bar(8, 2),
    ];
    expect(detectProgressionGroups(chords)).toEqual([
      { startIndex: 0, period: 2, repeatCount: 2, length: 4, partialTrailingRepeat: false },
      { startIndex: 4, period: 2, repeatCount: 2, length: 4, partialTrailingRepeat: false },
    ]);
  });

  it('leaves a single unrepeated chord ungrouped', () => {
    expect(detectProgressionGroups([bar(1, 0)])).toEqual([]);
  });

  it('handles an empty chord list', () => {
    expect(detectProgressionGroups([])).toEqual([]);
  });
});
