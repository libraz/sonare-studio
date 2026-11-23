import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, shallowRef } from 'vue';
import { useEngineProjectSync } from '@/composables/useEngineProjectSync';
import type { StripSync } from '@/engine/strip-sync';
import { useProjectStore } from '@/project/store';
import type { EditorClip, EditorTrack } from '@/project/types';
import { fakeMidiSync, fakeMixerSync } from './fakes/engine';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  return { ensureWasm: async () => createFakeWasmModule() };
});

const midiTrack: EditorTrack = {
  id: 1,
  name: 'Track 1',
  color: '#60a5fa',
  kind: 'midi',
  mute: false,
  solo: false,
  volume: 1,
  pan: 0,
  order: 1,
  instrument: { kind: 'synth-preset', preset: 'acoustic-piano' },
};

const midiClip: EditorClip = {
  id: 1,
  trackId: 1,
  name: 'Clip 1',
  startPpq: 0,
  lengthPpq: 1,
  sourceOffsetPpq: 0,
  gain: 1,
  loopEnabled: false,
  loopLengthPpq: 0,
  notes: [{ id: 1, pitch: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0 }],
};

describe('disposeEngineProjectSync timers', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.useRealTimers());

  it('cancels a pending MIDI sync', async () => {
    vi.useFakeTimers();
    const store = useProjectStore();
    store.dispose();
    await store.init();
    store.tracks = [midiTrack];
    store.clips = [midiClip];
    const midiSync = fakeMidiSync({
      sync: vi.fn(async () => undefined),
      scheduledClipCount: () => 1,
    });
    const handles = {
      mixerSync: fakeMixerSync({ sync: vi.fn(), laneTrackIds: () => [1] }),
      stripSync: { sync: vi.fn() } as unknown as StripSync,
      automationSync: null,
      midiSync,
      transportSync: null,
      webMidiOutput: null,
    };
    const scope = effectScope();
    const projectSync = scope.run(() =>
      useEngineProjectSync({
        bridge: shallowRef(null),
        scope: shallowRef(null),
        errorMessage: ref(''),
        handle: shallowRef(null),
        transport: { setTempoMap: vi.fn(), setTempo: vi.fn() } as never,
      }),
    );
    if (!projectSync) throw new Error('effect scope did not run');
    projectSync.setEngineSyncHandles(handles);
    await projectSync.syncMidiState();
    vi.mocked(midiSync.sync).mockClear();

    store.clips = store.clips.map((item) => ({
      ...item,
      notes: [{ ...item.notes[0], pitch: 61 }],
    }));
    await nextTick();
    projectSync.disposeEngineProjectSync();
    // A fresh engine installed before the stale timer would fire must not be synced by it.
    projectSync.setEngineSyncHandles(handles);
    await vi.advanceTimersByTimeAsync(1000);

    expect(midiSync.sync).not.toHaveBeenCalled();
    scope.stop();
  });
});
