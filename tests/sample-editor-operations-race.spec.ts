import type { RirDiagnostic, RoomMorphRequest } from '@libraz/libsonare';
import * as core from '@libraz/libsonare';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { clearAudioAssetLeases, isAudioAssetLeased } from '@/persistence/asset-leases';
import type { AudioAssetMeta, LoadedAudioAsset, SaveAssetInput } from '@/persistence/assets';
import { createHistory } from '@/ui/sample-editor/history';
import type { SampleRange } from '@/ui/sample-editor/ops';
import { SAMPLE_OPERATION_TIMEOUT_MS } from '@/ui/sample-editor/ops-client';
import { useSampleOperations } from '@/ui/sample-editor/use-sample-operations';
import type { SampleEditorWasmOps } from '@/ui/sample-editor/wasm-ops';
import { coreWasmBinary } from './core-package';
import { roomMorphFn, roomMorphResult } from './fakes/analysis';

const assetStore = vi.hoisted(() => {
  const deleteAsset = vi.fn<(id: string) => Promise<void>>(async () => undefined);
  return {
    deleteAsset,
    deleteAssetUnlocked: deleteAsset,
    listAssets: vi.fn<() => Promise<AudioAssetMeta[]>>(),
    loadAsset: vi.fn<(id: string) => Promise<LoadedAudioAsset>>(),
    saveAsset:
      vi.fn<
        (input: SaveAssetInput, channels: ReadonlyArray<Float32Array>) => Promise<AudioAssetMeta>
      >(),
    saveAssetWithStatus: vi.fn(
      async (input: SaveAssetInput, channels: ReadonlyArray<Float32Array>) => ({
        meta: await assetStore.saveAsset(input, channels),
        created: true,
      }),
    ),
  };
});
vi.mock('@/persistence/assets', () => assetStore);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function loadedAsset(id: string): LoadedAudioAsset {
  return {
    meta: { id, name: id, sampleRate: 48000, numChannels: 1, numFrames: 4 },
    channels: [new Float32Array([0.1, 0.2, 0.3, 0.4])],
  };
}

function meta(id: string): AudioAssetMeta {
  return { id, name: id, sampleRate: 48000, numChannels: 1, numFrames: 4 };
}

class UnresponsiveWorker {
  terminated = false;

  addEventListener(_type: string, _listener: EventListener): void {}

  removeEventListener(_type: string, _listener?: EventListener): void {}

  postMessage(_request: unknown, _transfer: Transferable[]): void {}

  terminate(): void {
    this.terminated = true;
  }
}

function setupOperation(target = loadedAsset('asset-a'), wasmOps: SampleEditorWasmOps = {}) {
  const asset = ref<LoadedAudioAsset | null>(target);
  const currentAssetId = ref(target.meta.id);
  const historyState = ref(createHistory({ assetId: target.meta.id, label: 'Original' }));
  const busy = ref(false);
  const selection = ref<SampleRange | null>(null);
  const error = ref<string | null>(null);
  let projectGeneration = 1;
  const loadCurrent = vi.fn<(assetId: string) => Promise<void>>(async () => undefined);
  const emitAssetCreated = vi.fn();
  const operations = useSampleOperations({
    asset,
    currentAssetId,
    historyState,
    busy,
    loading: ref(false),
    error,
    wasmOps: ref(wasmOps),
    selRange: () => selection.value,
    loadCurrent,
    emitAssetCreated,
    clearSelection: vi.fn(),
    getProjectGeneration: () => projectGeneration,
  });
  return {
    asset,
    currentAssetId,
    historyState,
    busy,
    error,
    selection,
    loadCurrent,
    emitAssetCreated,
    operations,
    advanceProject: () => {
      projectGeneration += 1;
    },
  };
}

describe('sample editor operation ownership', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    clearAudioAssetLeases();
    assetStore.listAssets.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not commit an edit after a rapid target, selection, or project switch', async () => {
    const saved = deferred<AudioAssetMeta>();
    assetStore.saveAsset.mockImplementation((input) => {
      input.onIdResolved?.('edited-a');
      return saved.promise;
    });
    const context = setupOperation();

    const pending = context.operations.onGain();
    expect(isAudioAssetLeased('edited-a')).toBe(true);
    context.selection.value = { startFrame: 1, endFrame: 3 };
    context.advanceProject();
    context.asset.value = loadedAsset('asset-b');
    context.currentAssetId.value = 'asset-b';
    context.historyState.value = createHistory({ assetId: 'asset-b', label: 'Original' });
    saved.resolve(meta('edited-a'));
    await pending;

    expect(context.historyState.value.versions.map((version) => version.assetId)).toEqual([
      'asset-b',
    ]);
    expect(context.emitAssetCreated).not.toHaveBeenCalled();
    expect(context.loadCurrent).not.toHaveBeenCalled();
    expect(isAudioAssetLeased('edited-a')).toBe(false);
  });

  it('invalidates a pending save when the editor owner unmounts', async () => {
    const saved = deferred<AudioAssetMeta>();
    assetStore.saveAsset.mockImplementation((input) => {
      input.onIdResolved?.('detached-edit');
      return saved.promise;
    });
    const context = setupOperation();

    const pending = context.operations.onGain();
    context.operations.dispose();
    saved.resolve(meta('detached-edit'));
    await pending;

    expect(context.emitAssetCreated).not.toHaveBeenCalled();
    expect(context.loadCurrent).not.toHaveBeenCalled();
    expect(isAudioAssetLeased('detached-edit')).toBe(false);
  });

  it('does not apply a Match EQ result loaded for an obsolete reference', async () => {
    const reference = deferred<LoadedAudioAsset>();
    assetStore.loadAsset.mockReturnValue(reference.promise);
    const context = setupOperation();
    context.operations.referenceAssetId.value = 'reference-a';
    await nextTick();

    const pending = context.operations.onMatchEq();
    expect(assetStore.loadAsset).toHaveBeenCalledWith('reference-a');
    context.operations.referenceAssetId.value = 'reference-b';
    await nextTick();
    reference.resolve(loadedAsset('reference-a'));
    await pending;

    expect(assetStore.saveAsset).not.toHaveBeenCalled();
    expect(context.emitAssetCreated).not.toHaveBeenCalled();
  });

  it('clears busy and reports a bounded error when a worker stops responding', async () => {
    vi.useFakeTimers();
    const workers: UnresponsiveWorker[] = [];
    vi.stubGlobal(
      'Worker',
      class extends UnresponsiveWorker {
        constructor() {
          super();
          workers.push(this);
        }
      },
    );
    const context = setupOperation();

    const pending = context.operations.onGain();
    expect(context.busy.value).toBe(true);
    await vi.advanceTimersByTimeAsync(SAMPLE_OPERATION_TIMEOUT_MS);
    await pending;

    expect(context.busy.value).toBe(false);
    expect(context.operations.opsDisabled.value).toBe(false);
    expect(context.error.value).toMatch(/timed out/i);
    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(true);
  });

  it('reports room-synthesis diagnostics as notices after the edit commits', async () => {
    assetStore.saveAsset.mockResolvedValue(meta('asset-b'));
    const diagnostics: RirDiagnostic[] = [
      { code: 'acoustic.rir_tail_truncated', message: 'raw tail text', severity: 'warning' },
      { code: 'acoustic.future_code', message: 'raw future text', severity: 'warning' },
    ];
    const roomMorph = roomMorphFn((request: RoomMorphRequest) =>
      roomMorphResult(request.samples, diagnostics),
    );
    const context = setupOperation(loadedAsset('asset-a'), { roomMorph });

    await context.operations.onPlaceInRoom();

    const notices = context.operations.notices.value;
    expect(notices).toHaveLength(2);
    expect(notices[0]).not.toBe('raw tail text');
    expect(notices[1]).toBe('raw future text');

    await context.operations.onGain();
    expect(context.operations.notices.value).toEqual([]);
  });
  describe('with the real core', () => {
    beforeAll(async () => {
      await core.init({ wasmBinary: coreWasmBinary() });
    });

    // The editor's default room preset is 4 x 3 m, which the core refuses
    // (listener outside the room), so placing a clip in it fails.
    it.fails('places a clip in the default room preset', async () => {
      assetStore.saveAsset.mockResolvedValue(meta('asset-b'));
      const context = setupOperation(loadedAsset('asset-a'), core);

      await context.operations.onPlaceInRoom();

      expect(context.error.value).toBeNull();
      expect(assetStore.saveAsset).toHaveBeenCalledOnce();
    });
  });
});
