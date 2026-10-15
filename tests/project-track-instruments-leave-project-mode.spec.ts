import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearHistory,
  setProjectExternalMidiDefault,
  setTrackExternalMidiMode,
  setTrackInstrument,
  setTrackInstruments,
  undo,
} from '@/project/commands';
import type { TrackInstrument } from '@/project/instrument';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const PRESET: TrackInstrument = { kind: 'synth-preset', preset: 'sub-bass' };

describe('picking an instrument on a track in project External MIDI mode', () => {
  let store: ReturnType<typeof useProjectStore>;
  let trackId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    trackId = store.tracks[0].id;
    setProjectExternalMidiDefault({ kind: 'external-midi', outputPortId: 'out-1', channel: 0 });
    setTrackInstrument(trackId, PRESET);
    setTrackExternalMidiMode(trackId, 'project');
    clearHistory();
    expect(store.tracks[0].externalMidiMode).toBe('project');
  });

  it('setTrackInstrument leaves project mode even for the instrument already stored', () => {
    setTrackInstrument(trackId, PRESET);

    expect(store.tracks[0].externalMidiMode).toBeUndefined();
    expect(store.tracks[0].instrument).toEqual(PRESET);
    expect(undo()).toBe(true);
    expect(store.tracks[0].externalMidiMode).toBe('project');
  });

  it('setTrackInstruments leaves project mode even for the instrument already stored', () => {
    setTrackInstruments([trackId], PRESET);

    expect(store.tracks[0].externalMidiMode).toBeUndefined();
    expect(undo()).toBe(true);
    expect(store.tracks[0].externalMidiMode).toBe('project');
  });

  it('clearing a track that has no instrument still leaves project mode', () => {
    setTrackInstrument(trackId, null);
    setTrackExternalMidiMode(trackId, 'project');
    clearHistory();

    setTrackInstrument(trackId, null);

    expect(store.tracks[0].externalMidiMode).toBeUndefined();
  });
});
