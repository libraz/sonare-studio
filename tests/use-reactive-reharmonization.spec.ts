import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type EffectScope, effectScope, nextTick } from 'vue';
import { useReactiveReharmonization } from '@/composables/useReactiveReharmonization';
import { clearHistory } from '@/project/command/history';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  return { ensureWasm: async () => createFakeWasmModule() };
});

describe('useReactiveReharmonization', () => {
  let store: ReturnType<typeof useProjectStore>;
  let scope: EffectScope;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    scope = effectScope();
  });

  afterEach(() => scope.stop());

  it('clears document-scoped locks when a replacement project reuses clip ids', async () => {
    const session = scope.run(() => useReactiveReharmonization());
    if (!session) throw new Error('effect scope did not run');
    session.toggleLock({ startPpq: 4, endPpq: 8 });
    expect(session.lockedRegions.value).toEqual([{ startPpq: 4, endPpq: 8 }]);

    store.documentGeneration += 1;
    await nextTick();

    expect(session.lockedRegions.value).toEqual([]);
    expect(session.pendingProposal.value).toBeNull();
  });

  it('does not activate melody reharmonization for a percussion track', async () => {
    const track = store.activeTrack;
    expect(track).not.toBeNull();
    if (!track) return;
    store.tracks = [{ ...track, percussion: true }];
    store.chords = [{ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 }];

    const session = scope.run(() => useReactiveReharmonization());
    if (!session) throw new Error('effect scope did not run');
    session.autoReharmonize.value = true;
    await nextTick();

    expect(session.reharmonizeActive.value).toBe(false);

    store.tracks = [{ ...track, percussion: false }];
    await nextTick();
    expect(session.reharmonizeActive.value).toBe(true);
  });

  it('classifies an empty active clip from percussion notes in a sibling clip', async () => {
    const track = store.activeTrack;
    const source = store.activeClip;
    expect(track).not.toBeNull();
    expect(source).not.toBeNull();
    if (!track || !source) return;
    store.tracks = [{ ...track }];
    store.clips = [
      {
        ...source,
        notes: [
          {
            id: 1,
            pitch: 36,
            velocity: 96,
            startPpq: 0,
            durationPpq: 0.25,
            channel: 9,
          },
        ],
      },
      { ...source, id: source.id + 1, startPpq: source.startPpq + source.lengthPpq, notes: [] },
    ];
    store.clipId = source.id + 1;
    store.notes = [];
    store.chords = [{ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 }];

    const session = scope.run(() => useReactiveReharmonization());
    if (!session) throw new Error('effect scope did not run');
    session.autoReharmonize.value = true;
    await nextTick();

    expect(session.reharmonizeActive.value).toBe(false);
  });
});
