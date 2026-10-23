import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addMidiClip,
  clearHistory,
  deleteClip,
  duplicateClip,
  moveClip,
  setActiveClip,
  trimClip,
} from '@/project/commands';
import { getProject, useProjectStore } from '@/project/store';
import {
  type ClipInteractionsView,
  useClipInteractions,
} from '@/ui/arrangement/use-clip-interactions';
import type { EditorToolId } from '@/ui/editor/tools';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** 10 px per PPQ, one 50 px lane per track. */
const view: ClipInteractionsView = {
  ppqToX: (ppq) => ppq * 10,
  xToPpq: (x) => x / 10,
  laneTop: (index) => index * 50,
  laneIndexAtY: (y) => Math.floor(y / 50),
  laneHeight: 50,
  laneCount: 1,
};

describe('refused clip gestures', () => {
  let store: ReturnType<typeof useProjectStore>;
  let trackId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    (getProject() as unknown as { enforceClipLanes(): void }).enforceClipLanes();
    trackId = store.tracks[0].id;
    deleteClip(store.clips[0].id);
    clearHistory();
  });

  const setup = () => {
    const errors: string[] = [];
    let tool: EditorToolId = 'select';
    const interactions = useClipInteractions({
      view,
      getClips: () => store.clips,
      getTrackIds: () => [trackId],
      getGridPpq: () => 1,
      getBarRange: (ppq) => ({ startPpq: Math.floor(ppq / 4) * 4, lengthPpq: 4 }),
      getTool: () => tool,
      onCommandError: (cause) =>
        errors.push(cause instanceof Error ? cause.message : String(cause)),
      commands: {
        selectClip: (id) => setActiveClip(id),
        moveClip,
        trimClip,
        duplicateClip,
        createClip: (track, startPpq, lengthPpq) =>
          addMidiClip({ trackId: track, startPpq, lengthPpq }),
      },
    });
    return {
      interactions,
      errors,
      setTool: (next: EditorToolId) => {
        tool = next;
      },
    };
  };

  const lane = () =>
    store.clips.map((clip) => [clip.id, clip.startPpq, clip.lengthPpq]).sort((a, b) => a[1] - b[1]);

  it('reports a move onto an occupied lane and leaves the clips in place', () => {
    addMidiClip({ trackId, startPpq: 0, lengthPpq: 4 });
    addMidiClip({ trackId, startPpq: 8, lengthPpq: 4 });
    const before = lane();
    const { interactions, errors } = setup();

    interactions.onPointerDown({ x: 20, y: 25 });
    interactions.onPointerMove({ x: 100, y: 25 });
    expect(() => interactions.onPointerUp({ x: 100, y: 25 })).not.toThrow();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/overlap/i);
    expect(lane()).toEqual(before);
    expect(interactions.previewClip.value).toBeNull();
  });

  it('reports a trim into a neighbour', () => {
    addMidiClip({ trackId, startPpq: 0, lengthPpq: 4 });
    addMidiClip({ trackId, startPpq: 4, lengthPpq: 4 });
    const before = lane();
    const { interactions, errors } = setup();

    interactions.onPointerDown({ x: 39.5, y: 25 });
    interactions.onPointerMove({ x: 60, y: 25 });
    interactions.onPointerUp({ x: 60, y: 25 });

    expect(errors).toHaveLength(1);
    expect(lane()).toEqual(before);
  });

  it('reports a double-click or draw over an existing clip', () => {
    addMidiClip({ trackId, startPpq: 1, lengthPpq: 2 });
    const before = lane();
    const { interactions, errors, setTool } = setup();

    interactions.onDoubleClick({ x: 35, y: 25 });
    setTool('draw');
    interactions.onPointerDown({ x: 0, y: 25 });
    interactions.onPointerMove({ x: 40, y: 25 });
    interactions.onPointerUp({ x: 40, y: 25 });

    expect(errors).toHaveLength(2);
    expect(lane()).toEqual(before);
  });
});
