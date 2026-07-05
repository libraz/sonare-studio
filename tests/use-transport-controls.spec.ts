import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, shallowRef } from 'vue';
import { useTransportControls } from '@/composables/useTransportControls';
import type { EngineHandle } from '@/engine/engine';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** Creates a manually-resolved promise for async race tests. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Builds a transport-controls harness with controllable refs and fakes. */
function harness() {
  const isPlaying = ref(true);
  const loopStartPpq = ref(16);
  const loopEndPpq = ref(32);
  const positionPpq = ref(0);
  const loopEnabled = ref(true);
  const armedTrackId = ref<number | null>(1);
  const isRecording = ref(false);

  const record = vi.fn(async (_at?: number, _end?: number) => {
    isRecording.value = true;
    return true;
  });
  const stopRecord = vi.fn(async () => {
    isRecording.value = false;
    return true;
  });

  const recording = { armedTrackId, isRecording, record, stopRecord } as unknown as Parameters<
    typeof useTransportControls
  >[0]['recording'];

  const transport = {
    play: vi.fn(),
    stop: vi.fn(),
    seekPpq: vi.fn(),
    setLoop: vi.fn(),
    setTempo: vi.fn(),
  } as unknown as Parameters<typeof useTransportControls>[0]['transport'];

  const scope = effectScope();
  const controls = scope.run(() =>
    useTransportControls({
      errorMessage: ref(''),
      handle: shallowRef(null),
      isPlaying,
      loopEnabled,
      loopEndPpq,
      loopStartPpq,
      positionPpq,
      recording,
      tempo: ref(120),
      transport,
      ensureEngineStarted: async () => null,
      onStopped: () => {},
      scheduleApply: () => {},
      syncTransportState: () => {},
    }),
  );
  if (!controls) throw new Error('effect scope did not run');

  return {
    controls,
    scope,
    isPlaying,
    loopStartPpq,
    loopEndPpq,
    positionPpq,
    armedTrackId,
    isRecording,
    record,
    stopRecord,
  };
}

describe('useTransportControls auto-punch', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    await store.init();
    h = harness();
    h.controls.autoPunchEnabled.value = true;
  });

  afterEach(() => {
    h.scope.stop();
  });

  it('punches in at the left locator when approaching it from before', async () => {
    h.positionPpq.value = 8; // still before the window
    await nextTick();
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record).toHaveBeenCalledWith(16, 32);
  });

  it('punches in at the current position when playback starts inside the window', async () => {
    h.positionPpq.value = 20; // started already inside [16, 32)
    await nextTick();
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record).toHaveBeenCalledWith(20, 32);
  });

  it('does not arm twice while a punch-in is pending', async () => {
    h.positionPpq.value = 4;
    await nextTick();
    h.positionPpq.value = 8;
    await nextTick();
    expect(h.record).toHaveBeenCalledTimes(1);
  });

  it('stops recording when the playhead reaches the right locator', async () => {
    h.positionPpq.value = 20;
    await nextTick();
    expect(h.isRecording.value).toBe(true);
    h.positionPpq.value = 32; // hits the right locator
    await nextTick();
    expect(h.stopRecord).toHaveBeenCalledTimes(1);
  });

  it('does not punch in past the right locator', async () => {
    h.positionPpq.value = 40; // started after the whole window
    await nextTick();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('does nothing when no track is armed', async () => {
    h.armedTrackId.value = null;
    h.positionPpq.value = 20;
    await nextTick();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('does nothing when auto-punch is disabled', async () => {
    h.controls.autoPunchEnabled.value = false;
    h.positionPpq.value = 20;
    await nextTick();
    expect(h.record).not.toHaveBeenCalled();
  });
});

describe('useTransportControls playback start races', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    await store.init();
  });

  function playbackHarness() {
    const pendingStart = deferred<EngineHandle | null>();
    const isPlaying = ref(false);
    const transport = {
      play: vi.fn(),
      stop: vi.fn(),
      seekPpq: vi.fn(),
      setLoop: vi.fn(),
      setTempo: vi.fn(),
    } as unknown as Parameters<typeof useTransportControls>[0]['transport'];
    const recording = {
      armedTrackId: ref<number | null>(null),
      isRecording: ref(false),
      record: vi.fn(async () => true),
      stopRecord: vi.fn(async () => true),
    } as unknown as Parameters<typeof useTransportControls>[0]['recording'];
    const scope = effectScope();
    const controls = scope.run(() =>
      useTransportControls({
        errorMessage: ref(''),
        handle: shallowRef(null),
        isPlaying,
        loopEnabled: ref(false),
        loopEndPpq: ref(0),
        loopStartPpq: ref(0),
        positionPpq: ref(0),
        recording,
        tempo: ref(120),
        transport,
        ensureEngineStarted: () => pendingStart.promise,
        onStopped: () => {},
        scheduleApply: () => {},
        syncTransportState: () => {},
      }),
    );
    if (!controls) throw new Error('effect scope did not run');
    return { controls, scope, pendingStart, transport };
  }

  it('does not play after a pending engine start is stopped', async () => {
    const h = playbackHarness();

    h.controls.startPlayback();
    h.controls.stopPlayback();
    h.pendingStart.resolve({} as EngineHandle);
    await nextTick();

    expect(h.transport.play).not.toHaveBeenCalled();
    h.scope.stop();
  });

  it('does not play after the owning scope is stopped during engine start', async () => {
    const h = playbackHarness();

    h.controls.startPlayback();
    h.scope.stop();
    h.pendingStart.resolve({} as EngineHandle);
    await nextTick();

    expect(h.transport.play).not.toHaveBeenCalled();
  });
});
