import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { clearAudioAssetLeases, isAudioAssetLeased } from '@/persistence/asset-leases';
import type { AudioAssetMeta, LoadedAudioAsset, SaveAssetInput } from '@/persistence/assets';
import { createHistory } from '@/ui/sample-editor/history';
import type { SampleRange } from '@/ui/sample-editor/ops';
import { useSampleOperations } from '@/ui/sample-editor/use-sample-operations';
import type { SampleEditorWasmOps } from '@/ui/sample-editor/wasm-ops';

const assetStore = vi.hoisted(() => ({
  deleteAsset: vi.fn<(id: string) => Promise<void>>(async () => undefined),
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
}));
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

function setupOperation(target = loadedAsset('asset-a')) {
  const asset = ref<LoadedAudioAsset | null>(target);
  const currentAssetId = ref(target.meta.id);
  const historyState = ref(createHistory({ assetId: target.meta.id, label: 'Original' }));
  const busy = ref(false);
  const selection = ref<SampleRange | null>(null);
  let projectGeneration = 1;
  const loadCurrent = vi.fn<(assetId: string) => Promise<void>>(async () => undefined);
  const emitAssetCreated = vi.fn();
  const operations = useSampleOperations({
    asset,
    currentAssetId,
    historyState,
    busy,
    loading: ref(false),
    error: ref(null),
    wasmOps: ref({} as SampleEditorWasmOps),
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
});
