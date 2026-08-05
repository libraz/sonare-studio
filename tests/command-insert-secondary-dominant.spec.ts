import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { secondaryDominantLabel } from '@/compose/secondary-dominant';
import { setProjectChords } from '@/project/command/chords';
import { clearHistory, undo } from '@/project/command/history';
import { insertSecondaryDominantBefore } from '@/project/command/insert-secondary-dominant';
import { useProjectStore } from '@/project/store';
import { MAJOR_MODE_MASK } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('insertSecondaryDominantBefore', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('splits the preceding chord and inserts a V7 over its second half', () => {
    setProjectChords([
      { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 }, // C
      { startPpq: 4, endPpq: 8, rootPc: 7, quality: 0 }, // G
    ]);

    const inserted = insertSecondaryDominantBefore(1);
    expect(inserted).toBe(true);

    expect(store.chords).toHaveLength(3);
    expect(store.chords[0]).toMatchObject({ rootPc: 0, quality: 0, startPpq: 0, endPpq: 2 });
    // V7/V: dominant seventh a fifth above the target's root (G -> D7).
    expect(store.chords[1]).toMatchObject({ rootPc: 2, quality: 4, startPpq: 2, endPpq: 4 });
    expect(store.chords[2]).toMatchObject({ rootPc: 7, quality: 0, startPpq: 4, endPpq: 8 });
  });

  it('splits the target itself when it is the first chord', () => {
    setProjectChords([{ startPpq: 0, endPpq: 8, rootPc: 0, quality: 0 }]); // C

    insertSecondaryDominantBefore(0);

    expect(store.chords).toHaveLength(2);
    // V7/I: dominant seventh a fifth above C -> G7.
    expect(store.chords[0]).toMatchObject({ rootPc: 7, quality: 4, startPpq: 0, endPpq: 4 });
    expect(store.chords[1]).toMatchObject({ rootPc: 0, quality: 0, startPpq: 4, endPpq: 8 });
  });

  it('fills a pre-existing gap without touching the preceding chord', () => {
    setProjectChords([
      { startPpq: 0, endPpq: 2, rootPc: 0, quality: 0 },
      { startPpq: 4, endPpq: 8, rootPc: 7, quality: 0 },
    ]);

    insertSecondaryDominantBefore(1);

    expect(store.chords).toHaveLength(3);
    expect(store.chords[0]).toMatchObject({ startPpq: 0, endPpq: 2 });
    expect(store.chords[1]).toMatchObject({ rootPc: 2, quality: 4, startPpq: 2, endPpq: 4 });
    expect(store.chords[2]).toMatchObject({ startPpq: 4, endPpq: 8 });
  });

  it('refuses to split a region too short to donate from', () => {
    setProjectChords([
      { startPpq: 0, endPpq: 1, rootPc: 0, quality: 0 },
      { startPpq: 1, endPpq: 5, rootPc: 7, quality: 0 },
    ]);

    const inserted = insertSecondaryDominantBefore(1);
    expect(inserted).toBe(false);
    expect(store.chords).toHaveLength(2);
  });

  it('does not tonicize a diminished target', () => {
    setProjectChords([{ startPpq: 0, endPpq: 4, rootPc: 11, quality: 2 }]);

    expect(insertSecondaryDominantBefore(0)).toBe(false);
    expect(store.chords).toEqual([{ startPpq: 0, endPpq: 4, rootPc: 11, quality: 2 }]);
  });

  it('labels the target by its root degree without quality or inversion figures', () => {
    expect(
      secondaryDominantLabel(
        { startPpq: 0, endPpq: 4, rootPc: 5, quality: 5, bassPc: 9 },
        { rootPc: 0, modeMask12: MAJOR_MODE_MASK },
      ),
    ).toBe('V7/IV');
  });

  it('is a single undoable edit', () => {
    setProjectChords([
      { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 },
      { startPpq: 4, endPpq: 8, rootPc: 7, quality: 0 },
    ]);

    insertSecondaryDominantBefore(1);
    expect(store.chords).toHaveLength(3);

    undo();
    expect(store.chords).toHaveLength(2);
    expect(store.chords[1]).toMatchObject({ rootPc: 7, quality: 0, startPpq: 4, endPpq: 8 });
  });

  it('ignores an out-of-range index', () => {
    setProjectChords([{ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 }]);
    const inserted = insertSecondaryDominantBefore(5);
    expect(inserted).toBe(false);
    expect(store.chords).toHaveLength(1);
  });
});
