import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reharmCandidatesFor } from '@/compose/reharm';
import { setProjectChords } from '@/project/command/chords';
import { clearHistory, undo } from '@/project/command/history';
import { reharmonizeChord } from '@/project/command/reharm';
import { useProjectStore } from '@/project/store';
import { MAJOR_MODE_MASK } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const C_MAJOR = { rootPc: 0, modeMask12: MAJOR_MODE_MASK };

describe('reharmonizeChord', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
  });

  it('replaces one chord with a substitute over the same region', () => {
    setProjectChords([
      { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 },
      { startPpq: 4, endPpq: 8, rootPc: 7, quality: 4 },
    ]);
    const [candidate] = reharmCandidatesFor(store.chords[1], C_MAJOR);
    expect(candidate).toBeDefined();

    reharmonizeChord(1, candidate);

    expect(store.chords).toHaveLength(2);
    // The first chord is untouched; the second becomes the candidate, region kept.
    expect(store.chords[0]).toMatchObject({ rootPc: 0, quality: 0 });
    expect(store.chords[1].startPpq).toBe(4);
    expect(store.chords[1].endPpq).toBe(8);
    expect(store.chords[1].rootPc).toBe(candidate.symbol.rootPc);
    expect(store.chords[1].quality).toBe(candidate.symbol.quality);
  });

  it('is a single undoable edit', () => {
    setProjectChords([{ startPpq: 0, endPpq: 4, rootPc: 7, quality: 4 }]);
    const before = { ...store.chords[0] };
    const [candidate] = reharmCandidatesFor(store.chords[0], C_MAJOR);

    reharmonizeChord(0, candidate);
    expect(store.chords[0].rootPc).toBe(candidate.symbol.rootPc);

    undo();
    expect(store.chords[0]).toMatchObject({ rootPc: before.rootPc, quality: before.quality });
  });

  it('ignores an out-of-range index', () => {
    setProjectChords([{ startPpq: 0, endPpq: 4, rootPc: 7, quality: 4 }]);
    const [candidate] = reharmCandidatesFor(store.chords[0], C_MAJOR);
    reharmonizeChord(5, candidate);
    expect(store.chords[0]).toMatchObject({ rootPc: 7, quality: 4 });
  });
});
