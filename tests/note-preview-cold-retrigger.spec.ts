import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowRef } from 'vue';
import { useNotePreview } from '@/composables/useNotePreview';
import type { EngineHandle } from '@/engine/engine';
import { addTrack, clearHistory, setActiveTrack } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { fakeEngineHandle } from './fakes/engine';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('useNotePreview retrigger on a cold engine', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    setActiveTrack(addTrack({ name: 'Synth' }));
  });

  it('leaves nothing ringing when one key-up follows two key-downs during engine start', async () => {
    const pushMidiNoteOn = vi.fn();
    const pushMidiNoteOff = vi.fn();
    const handle = shallowRef<EngineHandle | null>(
      fakeEngineHandle({ engine: { pushMidiNoteOn, pushMidiNoteOff }, ctx: { sampleRate: 48000 } }),
    );
    const starts: Array<(value: EngineHandle | null) => void> = [];
    const preview = useNotePreview({
      errorMessage: shallowRef(''),
      handle,
      hasMidiSync: () => true,
      ensureEngineStarted: () => new Promise((resolve) => starts.push(resolve)),
    });

    const first = preview.previewNoteOn(64, 100, 0);
    const second = preview.previewNoteOn(64, 100, 0);
    preview.previewNoteOff(64, 0);
    for (const start of starts) start(handle.value);
    await Promise.all([first, second]);

    expect(pushMidiNoteOn.mock.calls.length).toBe(pushMidiNoteOff.mock.calls.length);
  });
});
