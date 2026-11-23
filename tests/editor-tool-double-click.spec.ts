import { describe, expect, it, vi } from 'vitest';
import type { EditorNote } from '@/project/types';
import {
  type ClipInteractionCommands,
  useClipInteractions,
} from '@/ui/arrangement/use-clip-interactions';
import { TimelineRange } from '@/ui/canvas/timeline-range';
import type { EditorToolId } from '@/ui/editor/tools';
import {
  type InteractionCommands,
  useNoteInteractions,
} from '@/ui/piano-roll/use-note-interactions';

/** Double-click creation belongs to the select tool; the other tools act on the press alone. */
const NON_SELECT_TOOLS: EditorToolId[] = ['erase', 'split', 'draw'];

function noteHarness(tool: EditorToolId) {
  // 100 px per PPQ, 10 px rows: a pitch-60 note at PPQ [1, 2) covers x [100, 200), y [670, 680).
  const view = new TimelineRange({ widthPx: 800, heightPx: 1280, pxPerPpq: 100, rowHeight: 10 });
  const notes: EditorNote[] = [
    { id: 1, pitch: 60, velocity: 96, startPpq: 1, durationPpq: 1, channel: 0 },
  ];
  let nextId = 100;
  const commands: InteractionCommands = {
    addNote: vi.fn(() => nextId++),
    addNotes: vi.fn((inputs: ReadonlyArray<unknown>) => inputs.map(() => nextId++)),
    updateNotes: vi.fn(),
    deleteNotes: vi.fn((ids: Iterable<number>) => {
      for (const id of ids)
        notes.splice(
          notes.findIndex((note) => note.id === id),
          1,
        );
    }),
    setSelection: vi.fn(),
    splitNote: vi.fn(() => nextId++),
  };
  const interactions = useNoteInteractions({
    view,
    getNotes: () => notes,
    getSelection: () => new Set<number>(),
    getGridPpq: () => 0.25,
    getTool: () => tool,
    commands,
  });
  return { commands, interactions };
}

function clipHarness(tool: EditorToolId) {
  // 10 px per PPQ, two 50 px lanes; clip 1 covers x [40, 120) on lane 0.
  const clips = [{ id: 1, trackId: 10, startPpq: 4, lengthPpq: 8 }];
  const commands = {
    selectClip: vi.fn(),
    clearClipSelection: vi.fn(),
    moveClip: vi.fn(),
    trimClip: vi.fn(),
    duplicateClip: vi.fn(() => 99),
    createClip: vi.fn(() => 77),
    setClipFades: vi.fn(),
    deleteClip: vi.fn((id: number) => {
      clips.splice(
        clips.findIndex((clip) => clip.id === id),
        1,
      );
    }),
    splitClip: vi.fn(() => 88),
  } satisfies ClipInteractionCommands;
  const interactions = useClipInteractions({
    view: {
      ppqToX: (ppq) => ppq * 10,
      xToPpq: (x) => x / 10,
      laneTop: (index) => index * 50,
      laneIndexAtY: (y) => Math.floor(y / 50),
      laneHeight: 50,
      laneCount: 2,
    },
    getClips: () => clips,
    getTrackIds: () => [10, 20],
    getGridPpq: () => 1,
    getBarRange: (ppq) => ({ startPpq: Math.floor(ppq / 4) * 4, lengthPpq: 4 }),
    getTool: () => tool,
    commands,
  });
  return { commands, interactions };
}

/** Points over the existing item and over empty space. */
const NOTE_POINTS = { onItem: { x: 150, y: 675 }, empty: { x: 450, y: 675 } };
const CLIP_POINTS = { onItem: { x: 80, y: 25 }, empty: { x: 200, y: 25 } };
const CASES = NON_SELECT_TOOLS.flatMap((tool) =>
  (['onItem', 'empty'] as const).map((where) => ({ tool, where })),
);

/** A real double-click: two press/release pairs at one point, then the dblclick event. */
function doubleClick(
  target: {
    onPointerDown(point: { x: number; y: number }): void;
    onPointerUp(point: { x: number; y: number }): void;
  },
  point: { x: number; y: number },
): void {
  for (let i = 0; i < 2; i++) {
    target.onPointerDown(point);
    target.onPointerUp(point);
  }
}

describe('double-click outside the select tool', () => {
  it.each(CASES)('piano roll: $tool $where adds no note on dblclick', ({ tool, where }) => {
    const { commands, interactions } = noteHarness(tool);
    doubleClick(interactions, NOTE_POINTS[where]);
    const before = vi.mocked(commands.addNote).mock.calls.length;
    interactions.onDoubleClick(NOTE_POINTS[where]);
    expect(vi.mocked(commands.addNote).mock.calls.length).toBe(before);
  });

  it('piano roll: select still creates a note on empty space', () => {
    const { commands, interactions } = noteHarness('select');
    interactions.onDoubleClick(NOTE_POINTS.empty);
    expect(commands.addNote).toHaveBeenCalledTimes(1);
  });

  it.each(CASES)('arrangement: $tool $where adds no clip on dblclick', ({ tool, where }) => {
    const { commands, interactions } = clipHarness(tool);
    doubleClick(interactions, CLIP_POINTS[where]);
    const before = commands.createClip.mock.calls.length;
    interactions.onDoubleClick(CLIP_POINTS[where]);
    expect(commands.createClip.mock.calls.length).toBe(before);
  });

  it('arrangement: select still creates a clip on empty space', () => {
    const { commands, interactions } = clipHarness('select');
    interactions.onDoubleClick(CLIP_POINTS.empty);
    expect(commands.createClip).toHaveBeenCalledTimes(1);
  });
});
