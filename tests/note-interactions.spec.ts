import { describe, expect, it, vi } from 'vitest';
import {
  type InteractionCommands,
  useNoteInteractions,
} from '@/components/piano-roll/use-note-interactions';
import type { EditorNote } from '@/project/types';
import { TimelineRange } from '@/ui/canvas/timeline-range';

/** Builds an editor note with sensible defaults. */
function makeNote(partial: Partial<EditorNote> & { id: number }): EditorNote {
  return {
    pitch: 60,
    velocity: 96,
    startPpq: 1,
    durationPpq: 1,
    channel: 0,
    ...partial,
  };
}

/**
 * Test harness: real TimelineRange + hit-test, mocked commands. The selection
 * is mirrored locally so getSelection() reflects setSelection() calls the way
 * the project store would.
 *
 * View geometry: 100 px per PPQ, 10 px rows, no scroll. A pitch-60 note at
 * PPQ [1, 2) therefore covers x [100, 200) and y [670, 680).
 */
function makeHarness(notes: EditorNote[], initialSelection: number[] = []) {
  const view = new TimelineRange({ widthPx: 800, heightPx: 1280, pxPerPpq: 100, rowHeight: 10 });
  let selection = new Set<number>(initialSelection);
  let nextId = 100;
  const commands: InteractionCommands = {
    addNote: vi.fn(() => nextId++),
    updateNotes: vi.fn(),
    deleteNotes: vi.fn(),
    setSelection: vi.fn((ids: Iterable<number>) => {
      selection = new Set(ids);
    }),
  };
  const interactions = useNoteInteractions({
    view,
    getNotes: () => notes,
    getSelection: () => selection,
    getGridPpq: () => 0.25,
    commands,
  });
  return { view, commands, interactions, selection: () => selection };
}

const mocked = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

describe('useNoteInteractions', () => {
  describe('double-click create', () => {
    it('creates a note snapped to the grid cell with grid-step length and selects it', () => {
      const { commands, interactions } = makeHarness([makeNote({ id: 1 })]);
      // Empty area: x 337 = PPQ 3.37 (floor-snaps to 3.25), y 675 = pitch 60.
      interactions.onDoubleClick({ x: 337, y: 675 });
      expect(commands.addNote).toHaveBeenCalledTimes(1);
      expect(commands.addNote).toHaveBeenCalledWith({
        pitch: 60,
        startPpq: 3.25,
        durationPpq: 0.25,
      });
      expect(commands.setSelection).toHaveBeenLastCalledWith([100]);
    });

    it('bypasses snap with the meta modifier', () => {
      const { commands, interactions } = makeHarness([]);
      interactions.onDoubleClick({ x: 337, y: 675 }, { meta: true });
      const input = mocked(commands.addNote).mock.calls[0][0];
      expect(input.startPpq).toBeCloseTo(3.37, 9);
      expect(input.durationPpq).toBe(0.25);
    });

    it('does nothing when double-clicking an existing note', () => {
      const { commands, interactions } = makeHarness([makeNote({ id: 1 })]);
      interactions.onDoubleClick({ x: 150, y: 675 });
      expect(commands.addNote).not.toHaveBeenCalled();
    });
  });

  describe('move drag', () => {
    it('moves a note with snapped start and row-quantized pitch as one batch', () => {
      const { commands, interactions } = makeHarness([makeNote({ id: 1 })]);
      interactions.onPointerDown({ x: 150, y: 675 });
      expect(commands.setSelection).toHaveBeenCalledWith([1]);
      // +38 px = +0.38 PPQ raw -> grabbed start 1.38 snaps to 1.5; -30 px = +3 rows.
      interactions.onPointerMove({ x: 188, y: 645 });
      interactions.onPointerUp({ x: 188, y: 645 });
      expect(commands.updateNotes).toHaveBeenCalledTimes(1);
      expect(commands.updateNotes).toHaveBeenCalledWith([{ id: 1, startPpq: 1.5, pitch: 63 }]);
    });

    it('bypasses snap while meta is held', () => {
      const { commands, interactions } = makeHarness([makeNote({ id: 1 })]);
      interactions.onPointerDown({ x: 150, y: 675 });
      interactions.onPointerMove({ x: 188, y: 675 }, { meta: true });
      interactions.onPointerUp({ x: 188, y: 675 }, { meta: true });
      const update = mocked(commands.updateNotes).mock.calls[0][0][0];
      expect(update.startPpq).toBeCloseTo(1.38, 9);
      expect(update.pitch).toBe(60);
    });

    it('moves the whole selection by the delta of the grabbed note', () => {
      const notes = [makeNote({ id: 1 }), makeNote({ id: 2, startPpq: 2.5, pitch: 62 })];
      const { commands, interactions } = makeHarness(notes, [1, 2]);
      interactions.onPointerDown({ x: 150, y: 675 }); // grabs note 1 (already selected)
      interactions.onPointerMove({ x: 200, y: 675 }); // +0.5 PPQ snapped
      interactions.onPointerUp({ x: 200, y: 675 });
      expect(commands.updateNotes).toHaveBeenCalledWith([
        { id: 1, startPpq: 1.5, pitch: 60 },
        { id: 2, startPpq: 3, pitch: 62 },
      ]);
    });

    it('exposes a preview of the moved notes during the drag', () => {
      const { interactions } = makeHarness([makeNote({ id: 1 })]);
      interactions.onPointerDown({ x: 150, y: 675 });
      interactions.onPointerMove({ x: 200, y: 675 });
      expect(interactions.previewNotes.value).not.toBeNull();
      expect(interactions.previewNotes.value?.[0]).toMatchObject({ id: 1, startPpq: 1.5 });
      interactions.onPointerUp({ x: 200, y: 675 });
      expect(interactions.previewNotes.value).toBeNull();
    });

    it('treats movement below the drag threshold as a click (no edit)', () => {
      const { commands, interactions } = makeHarness([makeNote({ id: 1 })]);
      interactions.onPointerDown({ x: 150, y: 675 });
      interactions.onPointerMove({ x: 151, y: 675 });
      interactions.onPointerUp({ x: 151, y: 675 });
      expect(commands.updateNotes).not.toHaveBeenCalled();
      expect(commands.addNote).not.toHaveBeenCalled();
    });
  });

  describe('resize drag', () => {
    it('resizes the note end to a snapped duration', () => {
      const { commands, interactions } = makeHarness([makeNote({ id: 1 })]);
      // Note right edge at x 200; x 197 is inside the 4 px resize-end zone.
      interactions.onPointerDown({ x: 197, y: 675 });
      // End 2.0 + 0.65 raw = 2.65 snaps to 2.75 -> duration 1.75.
      interactions.onPointerMove({ x: 262, y: 675 });
      interactions.onPointerUp({ x: 262, y: 675 });
      expect(commands.updateNotes).toHaveBeenCalledTimes(1);
      expect(commands.updateNotes).toHaveBeenCalledWith([{ id: 1, durationPpq: 1.75 }]);
    });

    it('resizes the note start, keeping the end fixed', () => {
      const { commands, interactions } = makeHarness([makeNote({ id: 1 })]);
      // Note left edge at x 100; x 102 is inside the 4 px resize-start zone.
      interactions.onPointerDown({ x: 102, y: 675 });
      // Start 1.0 - 0.48 raw = 0.52 snaps to 0.5 -> duration 1.5.
      interactions.onPointerMove({ x: 54, y: 675 });
      interactions.onPointerUp({ x: 54, y: 675 });
      expect(commands.updateNotes).toHaveBeenCalledWith([
        { id: 1, startPpq: 0.5, durationPpq: 1.5 },
      ]);
    });

    it('never shrinks a note to zero or negative duration', () => {
      const { commands, interactions } = makeHarness([makeNote({ id: 1 })]);
      interactions.onPointerDown({ x: 197, y: 675 });
      interactions.onPointerMove({ x: 0, y: 675 }, { meta: true });
      interactions.onPointerUp({ x: 0, y: 675 }, { meta: true });
      const update = mocked(commands.updateNotes).mock.calls[0][0][0];
      expect(update.durationPpq).toBeGreaterThan(0);
    });
  });

  describe('marquee selection', () => {
    it('selects the notes intersecting the dragged rectangle', () => {
      const notes = [
        makeNote({ id: 1 }), // y [670, 680)
        makeNote({ id: 2, pitch: 115, startPpq: 3.5, durationPpq: 0.5 }), // x [350, 400), y [120, 130)
        makeNote({ id: 3, pitch: 100, startPpq: 3.5, durationPpq: 0.5 }), // y [270, 280)
      ];
      const { commands, interactions } = makeHarness(notes);
      interactions.onPointerDown({ x: 300, y: 100 });
      interactions.onPointerMove({ x: 500, y: 150 });
      expect(interactions.marquee.value).not.toBeNull();
      interactions.onPointerUp({ x: 500, y: 150 });
      expect(commands.setSelection).toHaveBeenLastCalledWith([2]);
      expect(commands.updateNotes).not.toHaveBeenCalled();
      expect(interactions.marquee.value).toBeNull();
    });

    it('adds to the existing selection when shift is held', () => {
      const notes = [
        makeNote({ id: 1 }),
        makeNote({ id: 2, pitch: 115, startPpq: 3.5, durationPpq: 0.5 }),
      ];
      const { interactions, selection } = makeHarness(notes, [1]);
      interactions.onPointerDown({ x: 300, y: 100 }, { shift: true });
      interactions.onPointerMove({ x: 500, y: 150 }, { shift: true });
      interactions.onPointerUp({ x: 500, y: 150 }, { shift: true });
      expect([...selection()]).toEqual([1, 2]);
    });

    it('clears the selection on a plain click in empty space', () => {
      const { commands, interactions } = makeHarness([makeNote({ id: 1 })], [1]);
      interactions.onPointerDown({ x: 600, y: 50 });
      interactions.onPointerUp({ x: 600, y: 50 });
      expect(commands.setSelection).toHaveBeenLastCalledWith([]);
    });
  });

  describe('click selection', () => {
    it('adds an unselected note to the selection on shift-click', () => {
      const { interactions, selection } = makeHarness(
        [makeNote({ id: 1 }), makeNote({ id: 2, pitch: 62 })],
        [2],
      );
      interactions.onPointerDown({ x: 150, y: 675 }, { shift: true });
      interactions.onPointerUp({ x: 150, y: 675 }, { shift: true });
      expect([...selection()].sort()).toEqual([1, 2]);
    });

    it('removes an already-selected note on shift-click', () => {
      const { interactions, selection } = makeHarness(
        [makeNote({ id: 1 }), makeNote({ id: 2, pitch: 62 })],
        [1, 2],
      );
      interactions.onPointerDown({ x: 150, y: 675 }, { shift: true });
      interactions.onPointerUp({ x: 150, y: 675 }, { shift: true });
      expect([...selection()]).toEqual([2]);
    });

    it('collapses a multi-selection to the clicked note on plain click', () => {
      const { interactions, selection } = makeHarness(
        [makeNote({ id: 1 }), makeNote({ id: 2, pitch: 62 })],
        [1, 2],
      );
      interactions.onPointerDown({ x: 150, y: 675 });
      interactions.onPointerUp({ x: 150, y: 675 });
      expect([...selection()]).toEqual([1]);
    });
  });

  describe('alt-drag duplicate', () => {
    it('creates copies at the dropped position and selects them', () => {
      const { commands, interactions } = makeHarness([makeNote({ id: 1 })]);
      interactions.onPointerDown({ x: 150, y: 675 }, { alt: true });
      interactions.onPointerMove({ x: 200, y: 675 }, { alt: true });
      interactions.onPointerUp({ x: 200, y: 675 }, { alt: true });
      expect(commands.updateNotes).not.toHaveBeenCalled();
      expect(commands.addNote).toHaveBeenCalledTimes(1);
      expect(commands.addNote).toHaveBeenCalledWith({
        pitch: 60,
        startPpq: 1.5,
        durationPpq: 1,
        velocity: 96,
        channel: 0,
      });
      expect(commands.setSelection).toHaveBeenLastCalledWith([100]);
    });

    it('marks the in-flight copies with negative preview ids', () => {
      const { interactions } = makeHarness([makeNote({ id: 1 })]);
      interactions.onPointerDown({ x: 150, y: 675 }, { alt: true });
      interactions.onPointerMove({ x: 200, y: 675 }, { alt: true });
      const preview = interactions.previewNotes.value;
      expect(preview).toHaveLength(2);
      expect(preview?.[0]).toMatchObject({ id: 1, startPpq: 1 });
      expect(preview?.[1]).toMatchObject({ id: -1, startPpq: 1.5 });
      interactions.cancel();
    });
  });

  describe('keyboard', () => {
    it('deletes the selection on Backspace and consumes the key', () => {
      const { commands, interactions } = makeHarness(
        [makeNote({ id: 1 }), makeNote({ id: 2, pitch: 62 })],
        [1, 2],
      );
      expect(interactions.onKeyDown('Backspace')).toBe(true);
      expect(commands.deleteNotes).toHaveBeenCalledWith([1, 2]);
    });

    it('ignores Delete when nothing is selected', () => {
      const { commands, interactions } = makeHarness([makeNote({ id: 1 })]);
      expect(interactions.onKeyDown('Delete')).toBe(false);
      expect(commands.deleteNotes).not.toHaveBeenCalled();
    });

    it('cancels an in-flight gesture on Escape without committing', () => {
      const { commands, interactions } = makeHarness([makeNote({ id: 1 })]);
      interactions.onPointerDown({ x: 150, y: 675 });
      interactions.onPointerMove({ x: 200, y: 675 });
      expect(interactions.onKeyDown('Escape')).toBe(true);
      expect(interactions.previewNotes.value).toBeNull();
      interactions.onPointerUp({ x: 200, y: 675 });
      expect(commands.updateNotes).not.toHaveBeenCalled();
    });
  });

  describe('hover feedback', () => {
    it('reflects the hovered zone in the cursor', () => {
      const { interactions } = makeHarness([makeNote({ id: 1 })]);
      interactions.onPointerMove({ x: 150, y: 675 });
      expect(interactions.cursor.value).toBe('pointer');
      interactions.onPointerMove({ x: 102, y: 675 });
      expect(interactions.cursor.value).toBe('ew-resize');
      interactions.onPointerMove({ x: 600, y: 50 });
      expect(interactions.cursor.value).toBe('default');
    });
  });
});
