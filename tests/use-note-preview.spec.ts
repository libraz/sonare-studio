import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowRef } from 'vue';
import { useNotePreview } from '@/composables/useNotePreview';
import type { EngineHandle } from '@/engine/engine';
import { addTrack, clearHistory, setActiveTrack } from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** A minimal engine handle exposing only the live-MIDI facade used by sustain. */
function makeHandle() {
  const pushMidiNoteOn = vi.fn();
  const pushMidiNoteOff = vi.fn();
  const handle = shallowRef<EngineHandle | null>({
    engine: { pushMidiNoteOn, pushMidiNoteOff },
    ctx: { sampleRate: 48000 },
  } as unknown as EngineHandle);
  return { handle, pushMidiNoteOn, pushMidiNoteOff };
}

describe('useNotePreview live MIDI sustain', () => {
  let store: ReturnType<typeof useProjectStore>;
  let midiTrackId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    midiTrackId = addTrack({ name: 'Synth' });
    setActiveTrack(midiTrackId);
  });

  function setup() {
    const { handle, pushMidiNoteOn, pushMidiNoteOff } = makeHandle();
    const errorMessage = shallowRef('');
    const preview = useNotePreview({
      errorMessage,
      handle,
      hasMidiSync: () => true,
      ensureEngineStarted: async () => handle.value,
    });
    return { preview, handle, pushMidiNoteOn, pushMidiNoteOff, errorMessage };
  }

  it('sustains a held note: note-on rings without an auto-scheduled note-off', async () => {
    const { preview, pushMidiNoteOn, pushMidiNoteOff } = setup();
    await preview.previewNoteOn(64, 100);

    expect(pushMidiNoteOn).toHaveBeenCalledTimes(1);
    expect(pushMidiNoteOn).toHaveBeenCalledWith(midiTrackId, 0, 0, 64, 100);
    // The key is still down: nothing released it yet (no fixed-length blip).
    expect(pushMidiNoteOff).not.toHaveBeenCalled();
  });

  it('releases the matching note on key-up', async () => {
    const { preview, pushMidiNoteOff } = setup();
    await preview.previewNoteOn(64, 100);
    preview.previewNoteOff(64);

    expect(pushMidiNoteOff).toHaveBeenCalledTimes(1);
    expect(pushMidiNoteOff).toHaveBeenCalledWith(midiTrackId, 0, 0, 64);
  });

  it('a stray key-up for a note that is not held is a no-op', () => {
    const { preview, pushMidiNoteOff } = setup();
    preview.previewNoteOff(70);
    expect(pushMidiNoteOff).not.toHaveBeenCalled();
  });

  it('retriggering the same pitch releases the previous note first', async () => {
    const { preview, pushMidiNoteOn, pushMidiNoteOff } = setup();
    await preview.previewNoteOn(64, 80);
    await preview.previewNoteOn(64, 110);

    // Second press releases the still-held note before sounding the new one.
    expect(pushMidiNoteOff).toHaveBeenCalledTimes(1);
    expect(pushMidiNoteOff).toHaveBeenCalledWith(midiTrackId, 0, 0, 64);
    expect(pushMidiNoteOn).toHaveBeenCalledTimes(2);
    expect(pushMidiNoteOn).toHaveBeenLastCalledWith(midiTrackId, 0, 0, 64, 110);
  });

  it('releaseAll releases every held note', async () => {
    const { preview, pushMidiNoteOff } = setup();
    await preview.previewNoteOn(60, 90);
    await preview.previewNoteOn(64, 90);
    await preview.previewNoteOn(67, 90);
    preview.releaseAll();

    expect(pushMidiNoteOff).toHaveBeenCalledTimes(3);
    expect(pushMidiNoteOff.mock.calls.map((c) => c[3]).sort((a, b) => a - b)).toEqual([60, 64, 67]);
  });

  it('auto-releases a held note after the safety timeout if the key-up is lost', async () => {
    vi.useFakeTimers();
    try {
      const { preview, pushMidiNoteOff } = setup();
      await preview.previewNoteOn(64, 100);
      expect(pushMidiNoteOff).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10000);
      expect(pushMidiNoteOff).toHaveBeenCalledWith(midiTrackId, 0, 0, 64);
    } finally {
      vi.useRealTimers();
    }
  });
});
