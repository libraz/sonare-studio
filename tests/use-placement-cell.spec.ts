import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useNoteInteractions } from '@/components/piano-roll/use-note-interactions';
import {
  describePlacementVerdict,
  usePlacementCell,
} from '@/components/piano-roll/use-placement-cell';
import type { PlacementVerdict } from '@/compose/placement';
import type { EditorNote } from '@/project/types';
import { TimelineRange } from '@/ui/canvas/timeline-range';
import type { EditorToolId } from '@/ui/editor/tools';
import { MESSAGES } from '@/ui/i18n';

function note(over: Partial<EditorNote> = {}): EditorNote {
  return { id: 1, pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0, ...over };
}

function harness(tool: EditorToolId = 'draw') {
  const hoverPpq = ref<number | null>(null);
  const toolRef = ref<EditorToolId>(tool);
  const previewNotes = ref<EditorNote[] | null>(null);
  const drawCellAt = vi.fn((ppq: number) => ({ startPpq: Math.floor(ppq), lengthPpq: 0.25 }));
  const cell = usePlacementCell({ hoverPpq, tool: toolRef, previewNotes, drawCellAt });
  return { hoverPpq, toolRef, previewNotes, drawCellAt, cell };
}

describe('usePlacementCell', () => {
  it('is the draw cell under the hovered position with the draw tool', () => {
    const h = harness();
    expect(h.cell.value).toBeNull();
    h.hoverPpq.value = 2.6;
    expect(h.cell.value).toEqual({ startPpq: 2, lengthPpq: 0.25 });
    expect(h.drawCellAt).toHaveBeenCalledWith(2.6);
  });

  it('follows the draft note (id < 0) while a draw drag is in flight', () => {
    const h = harness();
    h.hoverPpq.value = 7;
    h.previewNotes.value = [
      note({ id: 3, startPpq: 0 }),
      note({ id: -1, startPpq: 4, durationPpq: 1.5 }),
    ];
    expect(h.cell.value).toEqual({ startPpq: 4, lengthPpq: 1.5 });
  });

  it('is null for every tool other than draw', () => {
    for (const tool of ['select', 'split', 'erase'] as const) {
      const h = harness(tool);
      h.hoverPpq.value = 1;
      h.previewNotes.value = [note({ id: -1 })];
      expect(h.cell.value).toBeNull();
    }
  });

  it('starts on the same snapped cell a draw at that position would start on', () => {
    const view = new TimelineRange({ widthPx: 800, heightPx: 1280, pxPerPpq: 100, rowHeight: 10 });
    const interactions = useNoteInteractions({
      view,
      getNotes: () => [],
      getSelection: () => new Set(),
      getGridPpq: () => 0.25,
      getTool: () => 'draw',
      commands: {
        addNote: vi.fn(() => 1),
        updateNotes: vi.fn(),
        deleteNotes: vi.fn(),
        setSelection: vi.fn(),
      },
    });
    const point = { x: 237, y: 675 };
    const hovered = interactions.drawCellAt(view.xToPpq(point.x));
    interactions.onPointerDown(point);
    const draft = interactions.previewNotes.value?.find((entry) => entry.id < 0);
    expect(hovered).toEqual({ startPpq: draft?.startPpq, lengthPpq: 0.25 });
  });

  it('falls back to the minimum duration when snapping is off', () => {
    const view = new TimelineRange({ widthPx: 800, heightPx: 1280, pxPerPpq: 100, rowHeight: 10 });
    const interactions = useNoteInteractions({
      view,
      getNotes: () => [],
      getSelection: () => new Set(),
      getGridPpq: () => 0,
      commands: {
        addNote: vi.fn(() => 1),
        updateNotes: vi.fn(),
        deleteNotes: vi.fn(),
        setSelection: vi.fn(),
      },
    });
    expect(interactions.drawCellAt(1.37)).toEqual({ startPpq: 1.37, lengthPpq: 0.0625 });
  });
});

describe('describePlacementVerdict', () => {
  const pitchName = (pitch: number) => (pitch === 64 ? 'E4' : `p${pitch}`);
  const trackName = (id: number | null) => (id === 2 ? 'Backing' : id === 3 ? 'Bass' : 'clip');

  function verdict(over: Partial<PlacementVerdict>): PlacementVerdict {
    return { level: 'safe', reasons: [], partners: [], ...over };
  }

  it('names the thinned accompaniment note on a safe row', () => {
    const v = verdict({
      reasons: ['accompanimentThinned'],
      partners: [{ pitch: 64, trackId: 2, kind: 'accompNonRoot', thinned: true, following: true }],
    });
    expect(
      describePlacementVerdict(v, MESSAGES.ja.shell.pianoRoll.placement, pitchName, trackName),
    ).toBe('安全: Backing の E4 を間引きます');
  });

  it('appends the clash partner to a clash reason', () => {
    const v = verdict({
      level: 'warn',
      reasons: ['accompanimentThinnable'],
      partners: [{ pitch: 64, trackId: 2, kind: 'accompNonRoot', thinned: true, following: false }],
    });
    expect(
      describePlacementVerdict(v, MESSAGES.ja.shell.pianoRoll.placement, pitchName, trackName),
    ).toBe('警告: 伴奏を間引けば成立（Backing の E4）');
  });

  it('leaves partners off a motion reason and shows only the heaviest reason', () => {
    const v = verdict({
      level: 'ng',
      reasons: ['parallelPerfect', 'steppedNonChordTone'],
      partners: [{ pitch: 48, trackId: 3, kind: 'bass', thinned: false, following: false }],
    });
    const en = MESSAGES.en.shell.pianoRoll.placement;
    expect(describePlacementVerdict(v, en, pitchName, trackName)).toBe(
      `${en.level.ng}: ${en.reason.parallelPerfect}`,
    );
  });

  it('reads a plain safe row as the level alone', () => {
    const en = MESSAGES.en.shell.pianoRoll.placement;
    expect(describePlacementVerdict(verdict({}), en, pitchName, trackName)).toBe(en.level.safe);
  });
});
