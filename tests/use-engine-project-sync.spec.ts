import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref, shallowRef } from 'vue';
import { useEngineProjectSync } from '@/composables/useEngineProjectSync';
import type { MidiSync } from '@/engine/midi-sync';
import type { MixerSync } from '@/engine/mixer-sync';
import type { StripSync } from '@/engine/strip-sync';
import { useProjectStore } from '@/project/store';
import type { EditorClip, EditorTrack } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  return { ensureWasm: async () => createFakeWasmModule() };
});

function track(id: number): EditorTrack {
  return {
    id,
    name: `Track ${id}`,
    color: '#60a5fa',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: id,
    instrument: { kind: 'synth-preset', preset: 'acoustic-piano' },
  };
}

function clip(trackId: number): EditorClip {
  return {
    id: trackId,
    trackId,
    name: `Clip ${trackId}`,
    startPpq: 0,
    lengthPpq: 1,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [{ id: 1, pitch: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0 }],
  };
}

describe('useEngineProjectSync', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('declares mixer lanes before MIDI instrument binding', async () => {
    const store = useProjectStore();
    await store.init();
    store.tracks = [track(1)];
    store.clips = [clip(1)];

    const calls: string[] = [];
    const mixerSync: MixerSync = {
      sync: vi.fn(() => calls.push('mixer')),
      laneTrackIds: () => [1],
    };
    const stripSync = { sync: vi.fn(() => calls.push('strip')) } as unknown as StripSync;
    const midiSync: MidiSync = {
      sync: vi.fn(async () => {
        calls.push('midi');
      }),
      scheduledClipCount: () => 1,
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

    projectSync.setEngineSyncHandles({
      mixerSync,
      stripSync,
      automationSync: null,
      midiSync,
      transportSync: null,
      webMidiOutput: null,
    });

    await projectSync.syncMidiState();

    expect(calls).toEqual(['mixer', 'strip', 'midi']);
    scope.stop();
  });
});
