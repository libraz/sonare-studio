import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PayloadMemoryLimitError } from '@/lib/payload-memory';
import type { AudioAssetMeta } from '@/persistence/assets';
import {
  addAudioClip,
  addAudioTrack,
  clearHistory,
  transcribeAudioClipToMidi,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const assetStore = vi.hoisted(() => ({
  loadAssetMeta: vi.fn<(id: string) => Promise<AudioAssetMeta>>(),
  loadAsset: vi.fn(),
  audioAssetUri: (assetId: string) => `asset:${assetId}`,
}));
vi.mock('@/persistence/assets', () => assetStore);

describe('match-tempo transcription memory budget', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    vi.clearAllMocks();
    // Ten stereo minutes at 48 kHz: the whole-window render and its mono copy do not fit.
    assetStore.loadAssetMeta.mockImplementation(async (id) => ({
      id,
      name: id,
      sampleRate: 48_000,
      numChannels: 2,
      numFrames: 48_000 * 600,
    }));
    await store.init();
  });

  it('refuses before loading or rendering any audio', async () => {
    const trackId = addAudioTrack({ name: 'Audio' });
    const clipId = await addAudioClip({
      trackId,
      assetId: 'asset-1',
      lengthPpq: 1200,
      name: 'Long take',
    });
    const detectBeats = vi.fn();
    const transcribe = vi.fn();

    await expect(
      transcribeAudioClipToMidi(clipId, { matchTempo: true, detectBeats, transcribe }),
    ).rejects.toBeInstanceOf(PayloadMemoryLimitError);

    expect(assetStore.loadAsset).not.toHaveBeenCalled();
    expect(detectBeats).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });
});
