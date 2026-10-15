import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { clearAudioAssetLeases } from '@/persistence/asset-leases';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { useI18n } from '@/ui/i18n';
import { createHistory } from '@/ui/sample-editor/history';
import { useSampleOperations } from '@/ui/sample-editor/use-sample-operations';

const assetStore = vi.hoisted(() => ({
  deleteAsset: vi.fn(async () => undefined),
  deleteAssetUnlocked: vi.fn(async () => undefined),
  listAssets: vi.fn(async () => []),
  loadAsset: vi.fn(),
  saveAsset: vi.fn(),
  saveAssetWithStatus: vi.fn(),
}));
vi.mock('@/persistence/assets', () => assetStore);

function setup() {
  const target: LoadedAudioAsset = {
    meta: { id: 'a', name: 'a', sampleRate: 48000, numChannels: 1, numFrames: 4 },
    channels: [new Float32Array([0.1, 0.2, 0.3, 0.4])],
  };
  const error = ref<string | null>(null);
  const operations = useSampleOperations({
    asset: ref(target),
    currentAssetId: ref('a'),
    historyState: ref(createHistory({ assetId: 'a', label: 'Original' })),
    busy: ref(false),
    loading: ref(false),
    error,
    wasmOps: ref({}),
    selRange: () => null,
    loadCurrent: vi.fn(async () => undefined),
    emitAssetCreated: vi.fn(),
    clearSelection: vi.fn(),
  });
  return { error, operations };
}

describe('sample editor operation inputs', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    clearAudioAssetLeases();
  });

  it('rejects an unparseable normalize target instead of silently using -1 dB', async () => {
    const { error, operations } = setup();
    operations.normalizeTargetInput.value = 'loud';
    await operations.onNormalize();
    expect(error.value).toBe(useI18n().t.value.shell.sampleEditor.errors.normalizeTarget);
    expect(assetStore.saveAsset).not.toHaveBeenCalled();
  });
});
