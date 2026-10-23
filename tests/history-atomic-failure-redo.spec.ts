import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canRedo, clearHistory, executeAtomic, redo, undo } from '@/project/commands';
import { getProject, useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

function setTempo(bpm: number): void {
  const store = useProjectStore();
  executeAtomic((edit) => {
    edit(1, () => getProject().setTempoSegments([{ startPpq: 0, bpm }]));
    store.refresh();
  });
}

describe('redo after a failed atomic command', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('does not replay the rolled-back edit', () => {
    const store = useProjectStore();
    setTempo(100);
    setTempo(130);
    expect(undo()).toBe(true);
    expect(store.tempoSegments[0].bpm).toBe(100);

    expect(() =>
      executeAtomic((edit) => {
        edit(1, () => getProject().setTempoSegments([{ startPpq: 0, bpm: 200 }]));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.tempoSegments[0].bpm).toBe(100);

    expect(canRedo()).toBe(false);
    expect(redo()).toBe(false);
    expect(store.tempoSegments[0].bpm).toBe(100);
    expect(getProject().toJson()).not.toContain('"bpm":200');
  });

  it('keeps redo when the failing command made no native edit', () => {
    setTempo(100);
    expect(undo()).toBe(true);
    expect(() =>
      executeAtomic(() => {
        throw new Error('early');
      }),
    ).toThrow('early');
    expect(canRedo()).toBe(true);
  });
});
