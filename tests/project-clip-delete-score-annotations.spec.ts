import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addMidiClip,
  addNote,
  clearHistory,
  deleteClip,
  setNoteAnnotation,
  undo,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('deleteClip score annotations', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('keeps the annotation record when the clip has none', () => {
    const trackId = store.tracks[0].id;
    const keptClipId = store.clipId;
    const noteId = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    setNoteAnnotation(keptClipId, noteId, { dynamics: 'f' });
    const otherClipId = addMidiClip({ trackId, startPpq: 8, lengthPpq: 4 });
    const before = store.scoreAnnotations;

    deleteClip(otherClipId);

    expect(store.scoreAnnotations).toBe(before);
  });

  it('drops only the deleted clip annotations and restores them on undo', () => {
    const trackId = store.tracks[0].id;
    const keptClipId = store.clipId;
    const keptNote = addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    setNoteAnnotation(keptClipId, keptNote, { dynamics: 'f' });
    const otherClipId = addMidiClip({ trackId, startPpq: 8, lengthPpq: 4 });
    store.clipId = otherClipId;
    const otherNote = addNote({ pitch: 62, startPpq: 0, durationPpq: 1 });
    setNoteAnnotation(otherClipId, otherNote, { dynamics: 'p' });

    deleteClip(otherClipId);

    expect(Object.keys(store.scoreAnnotations).map(Number)).toEqual([keptClipId]);
    expect(undo()).toBe(true);
    expect(Object.keys(store.scoreAnnotations).map(Number).sort()).toEqual(
      [keptClipId, otherClipId].sort(),
    );
  });
});
