import { MAJOR_MASK } from '@libraz/libcantus';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyChangeProposal } from '@/compose/key-changes';
import { applyKeyChangeMarkers } from '@/project/command/key-changes';
import { clearHistory, undo } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

function proposal(partial: Partial<KeyChangeProposal>): KeyChangeProposal {
  return {
    startPpq: 0,
    key: { rootPc: 0, modeMask12: MAJOR_MASK },
    label: 'C major',
    selected: true,
    ...partial,
  };
}

describe('applyKeyChangeMarkers', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    await store.init();
    clearHistory();
  });

  it('adds one marker per selected proposal as a single undoable edit', () => {
    const added = applyKeyChangeMarkers([
      proposal({ startPpq: 0, key: { rootPc: 0, modeMask12: MAJOR_MASK }, label: 'C major' }),
      proposal({ startPpq: 1920, key: { rootPc: 7, modeMask12: MAJOR_MASK }, label: 'G major' }),
    ]);

    expect(added).toBe(2);
    const names = store.markers.map((marker) => marker.name).sort();
    expect(names).toEqual(['Key: C major', 'Key: G major']);

    expect(undo()).toBe(true);
    expect(store.markers).toEqual([]);
  });

  it('throws for an empty selection rather than treating it as a successful no-op', () => {
    expect(() => applyKeyChangeMarkers([])).toThrow(RangeError);
    expect(store.markers).toEqual([]);
  });
});
