import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { SILENCE_DB } from '@/lib/db';
import { busAutomationTarget } from '@/project/automation';
import type { EditorTrack } from '@/project/types';

const lifecycleMocks = vi.hoisted(() => ({
  createAnalyserBridge: vi.fn(),
  createEngine: vi.fn(),
  createMeterBridge: vi.fn(),
  createMidiSync: vi.fn(),
  createMixerSync: vi.fn(),
  createScopeBridge: vi.fn(),
  createStripSync: vi.fn(),
  createTransportSync: vi.fn(),
  createWebMidiOutput: vi.fn(),
  ensureWasm: vi.fn(),
}));

vi.mock('@/engine/analyser', () => ({
  createAnalyserBridge: lifecycleMocks.createAnalyserBridge,
}));
vi.mock('@/engine/engine', () => ({ createEngine: lifecycleMocks.createEngine }));
vi.mock('@/engine/meters', () => ({ createMeterBridge: lifecycleMocks.createMeterBridge }));
vi.mock('@/engine/midi-sync', () => ({ createMidiSync: lifecycleMocks.createMidiSync }));
vi.mock('@/engine/mixer-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/engine/mixer-sync')>()),
  createMixerSync: lifecycleMocks.createMixerSync,
  PFL_AUDITION_GAIN_DB: -12,
  pflAuditionStates: vi.fn((tracks: ReadonlyArray<unknown>) => tracks.map(() => false)),
}));
vi.mock('@/engine/scope', () => ({ createScopeBridge: lifecycleMocks.createScopeBridge }));
vi.mock('@/engine/strip-sync', () => ({
  createStripSync: lifecycleMocks.createStripSync,
  groupBusGainDb: vi.fn(() => 0),
}));
vi.mock('@/engine/transport-sync', () => ({
  createTransportSync: lifecycleMocks.createTransportSync,
}));
vi.mock('@/engine/web-midi-output', () => ({
  createWebMidiOutput: lifecycleMocks.createWebMidiOutput,
}));
vi.mock('@/lib/wasm', () => ({ ensureWasm: lifecycleMocks.ensureWasm }));

import {
  bindAudioContextState,
  canRestoreTrackInsertAutomationParam,
  type EngineLifecycleOptions,
  resetEngineTransportState,
  useEngineLifecycle,
} from '@/composables/useEngineLifecycle';
import type { EngineHandle } from '@/engine/engine';
import { useProjectStore } from '@/project/store';
import type { SonareEngine } from '@/wasm/worklet.js';

describe('useEngineLifecycle automation restore helpers', () => {
  it('skips track insert parameter restore while a track is frozen', () => {
    expect(canRestoreTrackInsertAutomationParam(undefined)).toBe(true);
    expect(canRestoreTrackInsertAutomationParam({ frozen: undefined })).toBe(true);
    expect(canRestoreTrackInsertAutomationParam({ frozen: { assetId: 'baked-1' } })).toBe(false);
  });

  it('removes AudioContext state listeners on dispose', () => {
    let listener: (() => void) | null = null;
    const ctx = {
      state: 'suspended',
      addEventListener: (_type: 'statechange', next: () => void) => {
        listener = next;
      },
      removeEventListener: (_type: 'statechange', next: () => void) => {
        if (listener === next) listener = null;
      },
    };
    const state = ref('');
    const dispose = bindAudioContextState(ctx, state);

    expect(state.value).toBe('suspended');
    expect(listener).toEqual(expect.any(Function));

    ctx.state = 'running';
    listener?.();
    expect(state.value).toBe('running');

    dispose();
    expect(listener).toBeNull();

    ctx.state = 'closed';
    listener?.();
    expect(state.value).toBe('running');
  });

  it('clears stale playing state while an engine is torn down', () => {
    const isPlaying = ref(true);
    resetEngineTransportState({ isPlaying } as never);
    expect(isPlaying.value).toBe(false);
  });
});

function makeLifecycleHandle(): {
  handle: EngineHandle;
  setAutomationLane: ReturnType<typeof vi.fn>;
  setBusGainDb: ReturnType<typeof vi.fn>;
} {
  const setAutomationLane = vi.fn();
  const setBusGainDb = vi.fn();
  const methods = {
    resolveBusAutomationId: vi.fn((busId: number, _paramName: 'faderDb') => 3000 + busId),
    setAutomationLane,
    setBusGainDb,
  } satisfies Partial<
    Pick<SonareEngine, 'resolveBusAutomationId' | 'setAutomationLane' | 'setBusGainDb'>
  >;
  const handle = {
    ctx: {
      sampleRate: 48_000,
      state: 'running',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    engine: {
      node: { onprocessorerror: null },
      ...methods,
      getTransportState: vi.fn(async () => ({})),
    },
    capabilities: {},
    dispose: vi.fn(async () => undefined),
  } as unknown as EngineHandle;
  return { handle, setAutomationLane, setBusGainDb };
}

function setupLifecycleForAutomationTest(): {
  store: ReturnType<typeof useProjectStore>;
  lifecycle: ReturnType<typeof useEngineLifecycle>;
  handle: ReturnType<typeof makeLifecycleHandle>;
  getAutomationSync: () => { sync: (lanes: readonly unknown[]) => void };
} {
  const store = useProjectStore();
  vi.spyOn(store, 'init').mockResolvedValue();
  const engine = makeLifecycleHandle();
  lifecycleMocks.createEngine.mockResolvedValue(engine.handle);

  let automationSync: { sync: (lanes: readonly unknown[]) => void } | undefined;
  const setEngineSyncHandles = vi.fn((handles: { automationSync: typeof automationSync }) => {
    automationSync = handles.automationSync;
  });
  const options: EngineLifecycleOptions = {
    analyser: { value: null },
    applyToEngine: vi.fn(async () => undefined),
    bootPromise: () => null,
    bridge: { value: null },
    ctxState: ref(''),
    errorMessage: ref(''),
    handle: { value: null },
    renderInfo: ref(''),
    resetEngineProjectSync: vi.fn(),
    runAction: async (action) => action(),
    scope: { value: null },
    setEngineSyncHandles: setEngineSyncHandles as EngineLifecycleOptions['setEngineSyncHandles'],
    syncAutomationState: vi.fn(),
    syncMidiState: vi.fn(async () => undefined),
    syncMixerState: vi.fn(),
    syncTransportState: vi.fn(),
    transport: {
      isPlaying: ref(false),
      loopEnabled: ref(false),
      loopStartPpq: ref(0),
      loopEndPpq: ref(4),
      metronomeEnabled: ref(false),
      setLoop: vi.fn(),
      setTempo: vi.fn(),
      toggleMetronome: vi.fn(),
    } as never,
  };

  return {
    store,
    lifecycle: useEngineLifecycle(options),
    handle: engine,
    getAutomationSync: () => {
      if (!automationSync) throw new Error('automation sync was not installed');
      return automationSync;
    },
  };
}

describe('useEngineLifecycle return-solo fader automation', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    lifecycleMocks.ensureWasm.mockResolvedValue({
      masteringInsertNames: () => [],
      masteringProcessorCatalog: () => [],
    });
    lifecycleMocks.createMixerSync.mockReturnValue({ laneTrackIds: () => [] });
    lifecycleMocks.createStripSync.mockReturnValue({
      busIdFor: (busId: string) => (busId === 'solo' ? 1 : busId === 'other' ? 2 : undefined),
      busInsertIndexFor: () => undefined,
      groupBusIdFor: () => undefined,
      groupInsertIndexFor: () => undefined,
      busMappingGeneration: () => 0,
      sceneGeneration: () => 0,
    });
    lifecycleMocks.createMidiSync.mockReturnValue({});
    lifecycleMocks.createTransportSync.mockReturnValue({});
    lifecycleMocks.createWebMidiOutput.mockReturnValue({
      dispose: vi.fn(),
      start: vi.fn(),
    });
    lifecycleMocks.createMeterBridge.mockReturnValue({ dispose: vi.fn() });
    lifecycleMocks.createAnalyserBridge.mockReturnValue({ dispose: vi.fn() });
    lifecycleMocks.createScopeBridge.mockReturnValue({ dispose: vi.fn() });
  });

  it('silences an automated non-solo return during solo and restores it afterward', async () => {
    const state = setupLifecycleForAutomationTest();
    state.store.mixer.buses = [
      { id: 'solo', name: 'Solo', gainDb: -3 },
      { id: 'other', name: 'Other', gainDb: -9 },
    ];
    await state.lifecycle.startEngine();
    const automation = state.getAutomationSync();
    const lane = {
      target: busAutomationTarget('other'),
      param: 'faderDb',
      points: [{ ppq: 0, value: 6 }],
      enabled: true,
    } as const;

    automation.sync([lane]);
    expect(state.handle.setAutomationLane).toHaveBeenCalledWith(3002, [
      { ppq: 0, value: 6, curveToNext: 'linear' },
    ]);
    state.handle.setAutomationLane.mockClear();

    state.store.mixer.buses[0].solo = true;
    automation.sync([lane]);

    expect(state.handle.setAutomationLane).toHaveBeenCalledWith(3002, []);
    expect(state.handle.setBusGainDb).toHaveBeenCalledWith(2, SILENCE_DB);
    state.handle.setAutomationLane.mockClear();
    state.handle.setBusGainDb.mockClear();

    state.store.mixer.buses[0].solo = false;
    automation.sync([lane]);
    automation.sync([]);

    expect(state.handle.setBusGainDb).toHaveBeenCalledWith(2, -9);
  });

  it('silences an automated group fader during return solo and restores it afterward', async () => {
    lifecycleMocks.createStripSync.mockReturnValue({
      busIdFor: (busId: string) => (busId === 'solo' ? 1 : undefined),
      busInsertIndexFor: () => undefined,
      groupBusIdFor: (trackId: number) => (trackId === 17 ? 7 : undefined),
      groupInsertIndexFor: () => undefined,
      busMappingGeneration: () => 0,
      sceneGeneration: () => 0,
    });
    const state = setupLifecycleForAutomationTest();
    state.store.tracks = [
      {
        id: 17,
        name: 'Group',
        color: '#60a5fa',
        kind: 'group',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        order: 0,
      } satisfies EditorTrack,
    ];
    state.store.mixer.buses = [{ id: 'solo', name: 'Solo', gainDb: -3 }];
    await state.lifecycle.startEngine();
    const automation = state.getAutomationSync();
    const lane = {
      target: 17,
      param: 'faderDb',
      points: [{ ppq: 0, value: -4 }],
      enabled: true,
    } as const;

    automation.sync([lane]);
    expect(state.handle.setAutomationLane).toHaveBeenCalledWith(3007, [
      { ppq: 0, value: -4, curveToNext: 'linear' },
    ]);
    state.handle.setAutomationLane.mockClear();

    state.store.mixer.buses[0].solo = true;
    automation.sync([lane]);

    expect(state.handle.setAutomationLane).toHaveBeenCalledWith(3007, []);
    expect(state.handle.setBusGainDb).toHaveBeenCalledWith(7, SILENCE_DB);
    state.handle.setAutomationLane.mockClear();
    state.handle.setBusGainDb.mockClear();

    state.store.mixer.buses[0].solo = false;
    automation.sync([lane]);
    automation.sync([]);

    expect(state.handle.setBusGainDb).toHaveBeenCalledWith(7, 0);
  });
});
