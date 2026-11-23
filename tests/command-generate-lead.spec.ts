import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setProjectChords } from '@/project/command/chords';
import { setTrackFrozen } from '@/project/command/clips-state';
import { createLeadMelodyCommand } from '@/project/command/generate-lead';
import { clearHistory, undo } from '@/project/command/history';
import { useProjectStore } from '@/project/store';
import { createTemplate } from '@/project/templates';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  return { ensureWasm: async () => createFakeWasmModule() };
});

describe('createLeadMelodyCommand', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    await store.loadDocument(createTemplate('empty'));
    setProjectChords([{ startPpq: 0, endPpq: 16, rootPc: 0, quality: 0 }]);
  });

  it('creates and selects a four-bar lead clip in one undo entry', () => {
    const clipId = createLeadMelodyCommand();
    expect(clipId).not.toBeNull();
    expect(store.tracks).toHaveLength(1);
    expect(store.tracks[0].name).toBe('Lead');
    expect(store.activeClip?.id).toBe(clipId);
    expect(store.activeClip?.lengthPpq).toBe(16);
    expect(store.activeClip?.notes).toHaveLength(0);
    expect(undo()).toBe(true);
    expect(store.tracks).toHaveLength(0);
    expect(store.clips).toHaveLength(0);
  });

  it('reuses the lead target when composing is requested again', () => {
    const first = createLeadMelodyCommand();
    const second = createLeadMelodyCommand();
    expect(second).toBe(first);
    expect(store.tracks).toHaveLength(1);
    expect(store.clips).toHaveLength(1);
  });

  it('creates an editable target when the previous lead is frozen', () => {
    const first = createLeadMelodyCommand();
    const frozenTrackId = store.activeTrackId;
    setTrackFrozen(frozenTrackId, { assetId: 'frozen-lead' });
    const second = createLeadMelodyCommand();
    expect(second).not.toBe(first);
    expect(store.activeTrack?.frozen).toBeUndefined();
    expect(store.activeClip?.lengthPpq).toBe(16);
    expect(store.clips.find((clip) => clip.id === first)).toBeDefined();
  });

  it('adds a spanning clip to the existing lead track when the chord progression grows', () => {
    const first = createLeadMelodyCommand();
    const firstTrackId = store.activeTrackId;
    setProjectChords([{ startPpq: 0, endPpq: 32, rootPc: 0, quality: 0 }]);
    const second = createLeadMelodyCommand();
    expect(second).not.toBe(first);
    expect(store.tracks).toHaveLength(1);
    expect(store.activeTrackId).toBe(firstTrackId);
    expect(store.activeClip?.lengthPpq).toBe(32);
    expect(store.clips.find((clip) => clip.id === first)?.lengthPpq).toBe(16);
    expect(undo()).toBe(true);
    expect(store.tracks).toHaveLength(1);
    expect(store.clips.map((clip) => clip.id)).toEqual([first]);
  });
});
