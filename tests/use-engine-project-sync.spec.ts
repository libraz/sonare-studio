import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, shallowRef } from 'vue';
import { useEngineProjectSync } from '@/composables/useEngineProjectSync';
import type { MidiSync } from '@/engine/midi-sync';
import type { MixerSync } from '@/engine/mixer-sync';
import type { StripSync } from '@/engine/strip-sync';
import type { WebMidiOutputBridge } from '@/engine/web-midi-output';
import {
  setProjectExternalMidiDefault,
  setTrackExternalMidiMode,
  setTrackMidiFx,
} from '@/project/commands';
import { sanitizeMidiFxConfig } from '@/project/midi-fx';
import { useProjectStore } from '@/project/store';
import type { EditorClip, EditorTrack } from '@/project/types';
import { resetAutomationStripModes, setAutomationStripMode } from '@/ui/mixer/automation-mode';

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
    resetAutomationStripModes();
  });

  it('declares mixer lanes before MIDI instrument binding', async () => {
    const store = useProjectStore();
    store.dispose();
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

  it('resyncs MIDI routing when External MIDI mode, shared route, or MIDI-FX changes', async () => {
    const store = useProjectStore();
    store.dispose();
    await store.init();
    store.tracks = [track(1)];
    store.clips = [clip(1)];

    const mixerSync: MixerSync = {
      sync: vi.fn(),
      laneTrackIds: () => [1],
    };
    const stripSync = { sync: vi.fn() } as unknown as StripSync;
    const midiSync: MidiSync = {
      sync: vi.fn(async () => undefined),
      scheduledClipCount: () => 1,
    };
    const webMidiOutput: WebMidiOutputBridge = {
      available: vi.fn(() => true),
      outputs: vi.fn(() => []),
      setRoutes: vi.fn(),
      syncRoutes: vi.fn(),
      start: vi.fn(async () => true),
      dispose: vi.fn(),
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
      webMidiOutput,
    });
    await projectSync.syncMidiState();
    expect(midiSync.sync).toHaveBeenCalledTimes(1);
    await nextTick();
    vi.mocked(midiSync.sync).mockClear();
    vi.mocked(webMidiOutput.syncRoutes).mockClear();

    setProjectExternalMidiDefault({ kind: 'external-midi', outputPortId: 'out-1', channel: 2 });
    await nextTick();
    await vi.waitFor(() => expect(midiSync.sync).toHaveBeenCalledTimes(1));
    expect(webMidiOutput.syncRoutes).toHaveBeenLastCalledWith(
      store.tracks,
      store.projectExternalMidi,
    );

    vi.mocked(midiSync.sync).mockClear();
    setTrackExternalMidiMode(store.tracks[0].id, 'project');
    await nextTick();
    await vi.waitFor(() => expect(midiSync.sync).toHaveBeenCalledTimes(1));

    vi.mocked(midiSync.sync).mockClear();
    setTrackMidiFx(store.tracks[0].id, sanitizeMidiFxConfig({ transposeSemitones: 12 }));
    await nextTick();
    await vi.waitFor(() => expect(midiSync.sync).toHaveBeenCalled());
    scope.stop();
  });

  it('keeps off-mode automation lanes out of the engine until read or write mode is enabled', async () => {
    const store = useProjectStore();
    store.dispose();
    await store.init();
    store.tracks = [track(1)];
    store.automationLanes = [
      { target: 1, param: 'faderDb', enabled: true, points: [{ ppq: 0, value: -6 }] },
    ];

    const automationSync = { sync: vi.fn() };
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
      mixerSync: null,
      stripSync: null,
      automationSync,
      midiSync: null,
      transportSync: null,
      webMidiOutput: null,
    });

    projectSync.syncAutomationState();
    expect(automationSync.sync).toHaveBeenLastCalledWith([]);

    setAutomationStripMode(1, 'read');
    await nextTick();

    expect(automationSync.sync).toHaveBeenLastCalledWith(store.automationLanes);
    scope.stop();
  });
});
