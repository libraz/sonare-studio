import { describe, expect, it, vi } from 'vitest';
import { clampMoveDelta, clampResizedDuration } from '@/components/piano-roll/nudge-bounds';
import {
  floorLocalPpqToMeterGrid,
  snapLocalPpqToMeterGrid,
} from '@/components/piano-roll/timeline-meter';
import {
  type InteractionCommands,
  useNoteInteractions,
} from '@/components/piano-roll/use-note-interactions';
import type { EditorNote, TimeSignatureSegment } from '@/project/types';
import { TimelineRange } from '@/ui/canvas/timeline-range';

const FOUR_FOUR: TimeSignatureSegment[] = [{ startPpq: 0, numerator: 4, denominator: 4 }];

function makeNote(partial: Partial<EditorNote> & { id: number }): EditorNote {
  return { pitch: 60, velocity: 96, startPpq: 1, durationPpq: 1, channel: 0, ...partial };
}

describe('clampMoveDelta', () => {
  const window = { min: 4, max: 8 };

  it('never moves a note against the requested direction', () => {
    // One note starts before the audible window (left-trimmed), one inside it.
    const notes = [
      { startPpq: 2, durationPpq: 4 },
      { startPpq: 5, durationPpq: 1 },
    ];
    expect(clampMoveDelta(-0.25, notes, window.min, window.max)).toBe(-0.25);
    expect(clampMoveDelta(0.25, notes, window.min, window.max)).toBe(0.25);
    expect(clampMoveDelta(-10, notes, window.min, window.max)).toBe(-1);
  });

  it('stops notes starting inside the window at its left edge', () => {
    const notes = [{ startPpq: 4.5, durationPpq: 1 }];
    expect(clampMoveDelta(-2, notes, window.min, window.max)).toBe(-0.5);
  });

  it('does not push a note that already overhangs the limit further right', () => {
    const notes = [{ startPpq: 6, durationPpq: 3 }];
    expect(clampMoveDelta(0.25, notes, window.min, window.max)).toBe(0);
    expect(clampMoveDelta(-0.25, notes, window.min, window.max)).toBe(-0.25);
  });

  it('stops a group at the right limit', () => {
    const notes = [{ startPpq: 6, durationPpq: 1.5 }];
    expect(clampMoveDelta(2, notes, window.min, window.max)).toBe(0.5);
  });
});

describe('clampResizedDuration', () => {
  it('keeps the length of an overhanging note when asked to grow', () => {
    expect(clampResizedDuration({ startPpq: 6, durationPpq: 3 }, 0.25, 8)).toBe(3);
  });

  it('grows up to the limit and shrinks down to the minimum', () => {
    expect(clampResizedDuration({ startPpq: 6, durationPpq: 1.5 }, 2, 8)).toBe(2);
    expect(clampResizedDuration({ startPpq: 6, durationPpq: 0.1 }, -1, 8)).toBe(0.0625);
  });
});

describe('pointer drag of a note that straddles the left window edge', () => {
  function harness(minPpq: number) {
    const view = new TimelineRange({ widthPx: 800, heightPx: 1280, pxPerPpq: 100, rowHeight: 10 });
    const commands: InteractionCommands = {
      addNote: vi.fn(() => 100),
      addNotes: vi.fn(() => [100]),
      updateNotes: vi.fn(),
      deleteNotes: vi.fn(),
      setSelection: vi.fn(),
      splitNote: vi.fn(() => 101),
    };
    const notes = [makeNote({ id: 1, startPpq: 0.5, durationPpq: 2 })];
    const interactions = useNoteInteractions({
      view,
      getNotes: () => notes,
      getSelection: () => new Set([1]),
      getGridPpq: () => 0.25,
      snapPpq: (ppq) => Math.round(ppq / 0.25) * 0.25,
      getMinPpq: () => minPpq,
      commands,
    });
    return { commands, interactions };
  }

  it('keeps its start on a vertical-only drag', () => {
    const { interactions } = harness(1);
    // Note spans x [50, 250) at pitch 60 (y 670..680).
    interactions.onPointerDown({ x: 150, y: 675 });
    interactions.onPointerMove({ x: 150, y: 655 });
    expect(interactions.previewNotes.value).toMatchObject([{ id: 1, startPpq: 0.5, pitch: 62 }]);
  });

  it('moves left when dragged left', () => {
    const { interactions } = harness(1);
    interactions.onPointerDown({ x: 150, y: 675 });
    interactions.onPointerMove({ x: 125, y: 675 });
    expect(interactions.previewNotes.value).toMatchObject([{ startPpq: 0.25 }]);
  });
});

describe('draw start on the meter-aware grid', () => {
  function drawHarness(origin: number, bar: boolean) {
    const view = new TimelineRange({ widthPx: 800, heightPx: 1280, pxPerPpq: 100, rowHeight: 10 });
    const addNote = vi.fn<InteractionCommands['addNote']>(() => 100);
    const step = bar ? 'bar' : 0.25;
    const interactions = useNoteInteractions({
      view,
      getNotes: () => [],
      getSelection: () => new Set<number>(),
      getGridPpq: () => 0.25,
      snapPpq: (ppq) => snapLocalPpqToMeterGrid(FOUR_FOUR, origin, ppq, step),
      floorPpq: (ppq) => floorLocalPpqToMeterGrid(FOUR_FOUR, origin, ppq, step),
      commands: {
        addNote,
        addNotes: vi.fn(() => [100]),
        updateNotes: vi.fn(),
        deleteNotes: vi.fn(),
        setSelection: vi.fn(),
        splitNote: vi.fn(() => 101),
      },
    });
    return { addNote, interactions };
  }

  it('starts a double-click note in the grid cell holding the pointer', () => {
    const { addNote, interactions } = drawHarness(0, false);
    // x 190 = PPQ 1.9: the right half of the 1.75 cell.
    interactions.onDoubleClick({ x: 190, y: 675 });
    expect(addNote).toHaveBeenCalledWith({ pitch: 60, startPpq: 1.75, durationPpq: 0.25 });
  });

  it('starts a note in the bar holding the pointer in Bar mode', () => {
    const { addNote, interactions } = drawHarness(0, true);
    interactions.onDoubleClick({ x: 390, y: 675 });
    expect(addNote.mock.calls[0][0]).toMatchObject({ startPpq: 0 });
  });

  it('uses the timeline bar line on a mid-bar clip origin', () => {
    const { addNote, interactions } = drawHarness(6, true);
    // Local PPQ 3.9 lies in the bar starting at local 2 (timeline 8).
    interactions.onDoubleClick({ x: 390, y: 675 });
    expect(addNote.mock.calls[0][0]).toMatchObject({ startPpq: 2 });
  });

  it('reports the same cell for the placement preview', () => {
    const { interactions } = drawHarness(0, false);
    expect(interactions.drawCellAt(1.9)).toEqual({ startPpq: 1.75, lengthPpq: 0.25 });
  });
});
