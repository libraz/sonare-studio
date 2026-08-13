import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addTrack, clearHistory } from '@/project/commands';
import { persistedProjectStateKey } from '@/project/persisted-state';
import {
  loadProjectDocument,
  type ProjectDocument,
  serializeProject,
} from '@/project/serialization';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('project persisted-state key', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('observes direct changes to every serialized control-surface field', () => {
    const defaultsKey = persistedProjectStateKey(store);

    store.controlSurface = {
      protocol: 'mcu',
      bankSize: 4,
      bankOffset: 1,
      inputPortId: 'surface-in',
      outputPortId: 'surface-out',
      feedback: true,
    };
    const configuredKey = persistedProjectStateKey(store);
    expect(configuredKey).not.toBe(defaultsKey);

    // bankOffset is serialized, so paging the saved surface window is also a
    // persisted-state change rather than a runtime-only control.
    store.controlSurface = { ...store.controlSurface, bankOffset: 0 };
    expect(persistedProjectStateKey(store)).not.toBe(configuredKey);
  });

  it('round-trips the configured surface, including bankOffset', async () => {
    addTrack({ name: 'Second track' });
    store.controlSurface = {
      protocol: 'hui',
      bankSize: 1,
      bankOffset: 1,
      inputPortId: 'surface-in',
      outputPortId: 'surface-out',
      feedback: true,
    };

    const document = serializeProject();
    expect(document.controlSurface).toEqual(store.controlSurface);

    await loadProjectDocument(JSON.parse(JSON.stringify(document)) as ProjectDocument);

    expect(store.controlSurface).toEqual(document.controlSurface);
    expect(serializeProject().controlSurface).toEqual(document.controlSurface);
  });
});
