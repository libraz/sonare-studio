import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, shallowRef } from 'vue';

const mocks = vi.hoisted(() => ({
  createAnalyserBridge: vi.fn(),
  createAutomationSync: vi.fn(),
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

vi.mock('@/engine/analyser', () => ({ createAnalyserBridge: mocks.createAnalyserBridge }));
vi.mock('@/engine/automation-sync', () => ({ createAutomationSync: mocks.createAutomationSync }));
vi.mock('@/engine/engine', () => ({ createEngine: mocks.createEngine }));
vi.mock('@/engine/meters', () => ({ createMeterBridge: mocks.createMeterBridge }));
vi.mock('@/engine/midi-sync', () => ({ createMidiSync: mocks.createMidiSync }));
vi.mock('@/engine/mixer-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/engine/mixer-sync')>()),
  createMixerSync: mocks.createMixerSync,
}));
vi.mock('@/engine/scope', () => ({ createScopeBridge: mocks.createScopeBridge }));
vi.mock('@/engine/strip-sync', () => ({
  createStripSync: mocks.createStripSync,
  groupBusGainDb: vi.fn(() => 0),
}));
vi.mock('@/engine/transport-sync', () => ({ createTransportSync: mocks.createTransportSync }));
vi.mock('@/engine/web-midi-output', () => ({
  createWebMidiOutput: mocks.createWebMidiOutput,
}));
vi.mock('@/lib/wasm', () => ({ ensureWasm: mocks.ensureWasm }));

import { ErrorCode, SonareError } from '@libraz/libsonare';
import { type EngineLifecycleOptions, useEngineLifecycle } from '@/composables/useEngineLifecycle';
import type { EngineHandle } from '@/engine/engine';
import { useProjectStore } from '@/project/store';
import { fakeEngineHandle } from './fakes/engine';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function makeHandle() {
  let stateListener: (() => void) | null = null;
  const dispose = vi.fn(async () => undefined);
  const handle = fakeEngineHandle({
    ctx: {
      sampleRate: 48_000,
      state: 'running',
      addEventListener: vi.fn((_type: 'statechange', listener: () => void) => {
        stateListener = listener;
      }),
      removeEventListener: vi.fn((_type: 'statechange', listener: () => void) => {
        if (stateListener === listener) stateListener = null;
      }),
    },
    engine: { node: { onprocessorerror: null } },
    capabilities: {},
    dispose,
  });
  return { dispose, handle };
}

function makeDisposable() {
  return { dispose: vi.fn() };
}

function setupLifecycle() {
  const store = useProjectStore();
  vi.spyOn(store, 'init').mockResolvedValue();
  const handle = shallowRef<EngineHandle | null>(null);
  const bridge = shallowRef(null);
  const analyser = shallowRef(null);
  const scope = shallowRef(null);
  const applyToEngine = vi.fn<EngineLifecycleOptions['applyToEngine']>(async () => undefined);
  const resetEngineProjectSync = vi.fn();
  const setEngineSyncHandles = vi.fn();
  const syncAutomationState = vi.fn();
  const syncMidiState = vi.fn(async () => undefined);
  const syncMixerState = vi.fn();
  const syncTransportState = vi.fn();
  const errorMessage = ref('');
  const lifecycle = useEngineLifecycle({
    analyser,
    applyToEngine,
    bootPromise: () => null,
    bridge,
    ctxState: ref(''),
    errorMessage,
    handle,
    renderInfo: ref(''),
    resetEngineProjectSync,
    runAction: async (action) => action(),
    scope,
    setEngineSyncHandles,
    syncAutomationState,
    syncMidiState,
    syncMixerState,
    syncTransportState,
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
  });
  return {
    analyser,
    applyToEngine,
    bridge,
    errorMessage,
    handle,
    lifecycle,
    resetEngineProjectSync,
    scope,
    syncMixerState,
  };
}

describe('useEngineLifecycle startup transaction', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mocks.ensureWasm.mockResolvedValue({
      masteringInsertNames: () => [],
      masteringProcessorCatalog: () => [],
    });
    mocks.createMixerSync.mockReturnValue({ laneTrackIds: () => [] });
    mocks.createStripSync.mockReturnValue({
      busIdFor: () => undefined,
      busInsertIndexFor: () => undefined,
      groupBusIdFor: () => undefined,
      groupInsertIndexFor: () => undefined,
    });
    mocks.createAutomationSync.mockReturnValue({});
    mocks.createMidiSync.mockReturnValue({});
    mocks.createTransportSync.mockReturnValue({});
    mocks.createWebMidiOutput.mockReturnValue({ dispose: vi.fn(), start: vi.fn() });
    mocks.createMeterBridge.mockImplementation(makeDisposable);
    mocks.createAnalyserBridge.mockImplementation(makeDisposable);
    mocks.createScopeBridge.mockImplementation(makeDisposable);
  });

  it('publishes refs only after initial project sync succeeds', async () => {
    const { handle: engineHandle } = makeHandle();
    mocks.createEngine.mockResolvedValue(engineHandle);
    const state = setupLifecycle();
    state.applyToEngine.mockImplementation(async (options) => {
      expect(options).toEqual({ handle: engineHandle, throwOnError: true });
      expect(state.handle.value).toBeNull();
      expect(state.bridge.value).toBeNull();
    });

    await state.lifecycle.startEngine();

    expect(state.handle.value).toBe(engineHandle);
    expect(state.bridge.value).not.toBeNull();
    expect(state.analyser.value).not.toBeNull();
    expect(state.scope.value).not.toBeNull();
  });

  it('re-sends a restored master fader value the engine ring refused', async () => {
    vi.useFakeTimers();
    try {
      const { handle: engineHandle } = makeHandle();
      const setStripFaderDb = vi.fn().mockImplementationOnce(() => {
        throw new SonareError(ErrorCode.OutOfMemory, 'command ring full');
      });
      (engineHandle as unknown as { engine: Record<string, unknown> }).engine.setStripFaderDb =
        setStripFaderDb;
      mocks.createEngine.mockResolvedValue(engineHandle);
      const state = setupLifecycle();
      await state.lifecycle.startEngine();
      const options = mocks.createAutomationSync.mock.calls[0][1] as {
        restoreParam: (target: string, param: string) => void;
      };

      options.restoreParam('master', 'faderDb');
      expect(setStripFaderDb).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(200);
      expect(setStripFaderDb).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(500);
      expect(setStripFaderDb).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rolls back a failed initial sync and permits a clean retry', async () => {
    const first = makeHandle();
    const second = makeHandle();
    mocks.createEngine.mockResolvedValueOnce(first.handle).mockResolvedValueOnce(second.handle);
    const state = setupLifecycle();
    state.syncMixerState.mockImplementationOnce(() => {
      throw new Error('mixer init failed');
    });

    await expect(state.lifecycle.startEngine()).rejects.toThrow('mixer init failed');

    expect(state.handle.value).toBeNull();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(state.resetEngineProjectSync).toHaveBeenCalledTimes(1);

    await expect(state.lifecycle.startEngine()).resolves.toBeUndefined();
    expect(state.handle.value).toBe(second.handle);
  });

  it('invalidates an in-flight start on dispose and destroys its late handle', async () => {
    const pending = deferred<EngineHandle>();
    const late = makeHandle();
    let startupSignal: AbortSignal | undefined;
    mocks.createEngine.mockImplementation(async (options) => {
      startupSignal = options.signal;
      return pending.promise;
    });
    const state = setupLifecycle();

    const start = state.lifecycle.startEngine();
    await vi.waitFor(() => expect(startupSignal).toBeDefined());
    state.lifecycle.disposeEngineLifecycle();
    pending.resolve(late.handle);

    await expect(start).rejects.toMatchObject({ name: 'AbortError' });
    expect(startupSignal?.aborted).toBe(true);
    expect(late.dispose).toHaveBeenCalledTimes(1);
    expect(state.handle.value).toBeNull();
  });

  it('rebuilds a structurally uncertain live engine from a clean sync transaction', async () => {
    const first = makeHandle();
    const second = makeHandle();
    mocks.createEngine.mockResolvedValueOnce(first.handle).mockResolvedValueOnce(second.handle);
    const state = setupLifecycle();
    await state.lifecycle.startEngine();
    const firstBridge = state.bridge.value as unknown as ReturnType<typeof makeDisposable>;
    const firstAnalyser = state.analyser.value as unknown as ReturnType<typeof makeDisposable>;
    const firstScope = state.scope.value as unknown as ReturnType<typeof makeDisposable>;

    await state.lifecycle.restartEngine();

    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(firstBridge.dispose).toHaveBeenCalledTimes(1);
    expect(firstAnalyser.dispose).toHaveBeenCalledTimes(1);
    expect(firstScope.dispose).toHaveBeenCalledTimes(1);
    expect(state.resetEngineProjectSync).toHaveBeenCalledTimes(1);
    expect(state.handle.value).toBe(second.handle);
  });

  it('shares one in-flight teardown and delays a replacement until it completes', async () => {
    const pendingDispose = deferred<void>();
    const first = makeHandle();
    first.dispose.mockReturnValue(pendingDispose.promise);
    const second = makeHandle();
    mocks.createEngine.mockResolvedValueOnce(first.handle).mockResolvedValueOnce(second.handle);
    const state = setupLifecycle();
    await state.lifecycle.startEngine();

    const firstTeardown = state.lifecycle.disposeEngineLifecycle();
    const secondTeardown = state.lifecycle.disposeEngineLifecycle();
    const replacement = state.lifecycle.ensureEngineStarted();

    expect(secondTeardown).toBe(firstTeardown);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.createEngine).toHaveBeenCalledTimes(1);

    pendingDispose.resolve();
    await expect(Promise.all([firstTeardown, secondTeardown])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    await expect(replacement).resolves.toBe(second.handle);
    expect(mocks.createEngine).toHaveBeenCalledTimes(2);
  });

  it('tears down a crashed published worklet and starts a clean replacement', async () => {
    const first = makeHandle();
    const second = makeHandle();
    mocks.createEngine.mockResolvedValueOnce(first.handle).mockResolvedValueOnce(second.handle);
    const state = setupLifecycle();
    await state.lifecycle.startEngine();
    const firstBridge = state.bridge.value as unknown as ReturnType<typeof makeDisposable>;
    const firstAnalyser = state.analyser.value as unknown as ReturnType<typeof makeDisposable>;
    const firstScope = state.scope.value as unknown as ReturnType<typeof makeDisposable>;

    first.handle.engine.node.onprocessorerror?.(new Event('processorerror'));

    expect(state.handle.value).toBeNull();
    expect(state.bridge.value).toBeNull();
    expect(state.analyser.value).toBeNull();
    expect(state.scope.value).toBeNull();
    await vi.waitFor(() => expect(first.dispose).toHaveBeenCalledTimes(1));
    expect(firstBridge.dispose).toHaveBeenCalledTimes(1);
    expect(firstAnalyser.dispose).toHaveBeenCalledTimes(1);
    expect(firstScope.dispose).toHaveBeenCalledTimes(1);
    expect(state.resetEngineProjectSync).toHaveBeenCalledTimes(1);
    expect(state.errorMessage.value).toContain('processor crashed');

    await expect(state.lifecycle.ensureEngineStarted()).resolves.toBe(second.handle);
    expect(state.handle.value).toBe(second.handle);
  });

  it('records a failed crash cleanup, retries it, and still permits engine recovery', async () => {
    const first = makeHandle();
    first.dispose.mockRejectedValueOnce(new Error('destroy failed'));
    const second = makeHandle();
    mocks.createEngine.mockResolvedValueOnce(first.handle).mockResolvedValueOnce(second.handle);
    const state = setupLifecycle();
    await state.lifecycle.startEngine();

    first.handle.engine.node.onprocessorerror?.(new Event('processorerror'));
    await vi.waitFor(() => expect(state.lifecycle.cleanupFailures.value).toHaveLength(1));
    expect(state.lifecycle.cleanupFailures.value[0]).toMatchObject({ stage: 'engine' });
    expect(state.errorMessage.value).toContain('destroy failed');

    await expect(state.lifecycle.ensureEngineStarted()).resolves.toBe(second.handle);
    expect(first.dispose).toHaveBeenCalledTimes(2);
    expect(state.handle.value).toBe(second.handle);
  });
});
