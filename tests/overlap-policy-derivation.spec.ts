import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addAudioClip,
  addAudioTrack,
  clearHistory,
  crossfadeClips,
  deleteClip,
  redo,
  trimClip,
  undo,
} from '@/project/commands';
import { serializeProject } from '@/project/serialization';
import { getProject, useProjectStore } from '@/project/store';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('overlap policy follows the document', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    installMockOpfs();
    setActivePinia(createPinia());
    store = useProjectStore();
    await store.init();
    clearHistory();
  });

  afterEach(() => {
    uninstallMockOpfs();
  });

  async function crossfadedPair(): Promise<{ left: number; right: number }> {
    const trackId = addAudioTrack();
    const left = await addAudioClip({ trackId, assetId: 'a', lengthPpq: 4, startPpq: 0 });
    const right = await addAudioClip({ trackId, assetId: 'b', lengthPpq: 4, startPpq: 4 });
    crossfadeClips(left, right, { lengthPpq: 1, leftSourceEndPpq: 8 });
    expect(getProject().overlapPolicy).toBe('allow');
    return { left, right };
  }

  async function reloadedPolicy(): Promise<string> {
    await store.loadDocument(serializeProject());
    return getProject().overlapPolicy;
  }

  it('returns to disallow when deleting a clip removes the last overlap, inside the same undo step', async () => {
    const { right } = await crossfadedPair();

    deleteClip(right);
    expect(getProject().overlapPolicy).toBe('disallow');

    expect(undo()).toBe(true);
    expect(getProject().overlapPolicy).toBe('allow');
    expect(redo()).toBe(true);
    expect(getProject().overlapPolicy).toBe('disallow');
  });

  it('matches what a reload of the same document derives after a trim ends the overlap', async () => {
    const { left } = await crossfadedPair();

    trimClip(left, 0, 4);
    const sessionPolicy = getProject().overlapPolicy;

    expect(sessionPolicy).toBe(await reloadedPolicy());
    expect(sessionPolicy).toBe('disallow');
  });

  it('keeps allow while the crossfade overlap remains', async () => {
    await crossfadedPair();
    const trackId = addAudioTrack();
    await addAudioClip({ trackId, assetId: 'c', lengthPpq: 2, startPpq: 0 });

    expect(getProject().overlapPolicy).toBe('allow');
    expect(await reloadedPolicy()).toBe('allow');
  });
});
