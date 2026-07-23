import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCompositionGuidance } from '@/composables/useCompositionGuidance';
import { addNote, clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('useCompositionGuidance', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('derives a grid segment and a theory-card resolver from the active clip', () => {
    const noteId = addNote({ pitch: 60, startPpq: 0, durationPpq: 1, velocity: 96 });
    const guidance = useCompositionGuidance();

    expect(guidance.guidanceSegments.value).toBeDefined();
    expect(guidance.guidanceSegments.value?.[0].endBeat).toBeGreaterThan(0);
    expect(guidance.noteCard.value?.(noteId)).not.toBeNull();
    expect(guidance.resolutionArrows.value).toEqual(expect.any(Array));
  });
});
