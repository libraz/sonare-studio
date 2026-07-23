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
});
