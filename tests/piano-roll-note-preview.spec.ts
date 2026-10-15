import { describe, expect, it, vi } from 'vitest';
import { isReactive } from 'vue';
import { useNoteInteractions } from '@/components/piano-roll/use-note-interactions';
import type { EditorNote } from '@/project/types';
import { TimelineRange } from '@/ui/canvas/timeline-range';

function note(id: number, pitch: number, startPpq: number): EditorNote {
  return { id, pitch, velocity: 96, startPpq, durationPpq: 1, channel: 0 };
}

function setup(tool: 'select' | 'draw' | 'erase') {
  const notes = [note(1, 60, 1), note(2, 64, 3), note(3, 67, 5)];
  const view = new TimelineRange({ widthPx: 800, heightPx: 1280, pxPerPpq: 100, rowHeight: 10 });
  let selection = new Set<number>();
  const interactions = useNoteInteractions({
    view,
    getNotes: () => notes,
    getSelection: () => selection,
    getGridPpq: () => 0.25,
    getTool: () => tool,
    commands: {
      addNote: vi.fn(() => 100),
      addNotes: vi.fn(() => [100]),
      updateNotes: vi.fn(),
      deleteNotes: vi.fn(),
      setSelection: vi.fn((ids: Iterable<number>) => {
        selection = new Set(ids);
      }),
    },
  });
  return { notes, interactions };
}

describe('note preview structural sharing', () => {
  it('reuses untouched note objects during a move drag', () => {
    const { notes, interactions } = setup('select');
    interactions.onPointerDown({ x: 150, y: 675 });
    interactions.onPointerMove({ x: 200, y: 675 });
    const preview = interactions.previewNotes.value;
    expect(preview?.[0]).not.toBe(notes[0]);
    expect(preview?.[1]).toBe(notes[1]);
    expect(preview?.[2]).toBe(notes[2]);
    expect(isReactive(preview)).toBe(false);
    interactions.cancel();
  });

  it('reuses store note objects in a draw preview', () => {
    const { notes, interactions } = setup('draw');
    interactions.onPointerDown({ x: 450, y: 675 });
    interactions.onPointerMove({ x: 500, y: 675 });
    const preview = interactions.previewNotes.value;
    expect(preview?.[0]).toBe(notes[0]);
    expect(preview).toHaveLength(4);
    interactions.cancel();
  });

  it('reuses surviving note objects in an erase preview', () => {
    const { notes, interactions } = setup('erase');
    interactions.onPointerDown({ x: 150, y: 675 });
    const preview = interactions.previewNotes.value;
    expect(preview).toHaveLength(2);
    expect(preview?.[0]).toBe(notes[1]);
    interactions.cancel();
  });
});
