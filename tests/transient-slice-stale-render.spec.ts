import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addAudioClip,
  addAudioTrack,
  clearHistory,
  sliceAudioClipAtTransients,
  trimClip,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const SAMPLE_RATE = 1000;

/** 10 s mono asset with a short click at each listed second. */
function clickAsset(clicks: number[]) {
  const frames = 10 * SAMPLE_RATE;
  const channel = new Float32Array(frames);
  for (const seconds of clicks) channel.fill(1, seconds * SAMPLE_RATE, seconds * SAMPLE_RATE + 4);
  return {
    meta: {
      id: 'take',
      name: 'take.wav',
      sampleRate: SAMPLE_RATE,
      numChannels: 1,
      numFrames: frames,
    },
    channels: [channel],
  };
}

function detectClicks(samples: Float32Array, sampleRate: number): number[] {
  const onsets: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (samples[i] > 0.5 && (i === 0 || samples[i - 1] <= 0.5)) onsets.push(i / sampleRate);
  }
  return onsets;
}

describe('transient slicing against a clip edited during analysis', () => {
  beforeEach(async () => {
    installMockOpfs();
    setActivePinia(createPinia());
    await useProjectStore().init();
    clearHistory();
  });

  afterEach(() => {
    uninstallMockOpfs();
  });

  it('places no cuts computed from the audio the clip played before the edit', async () => {
    const store = useProjectStore();
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({ trackId, assetId: 'take', lengthPpq: 8, startPpq: 0 });
    const asset = clickAsset([1, 2]);

    const result = await sliceAudioClipAtTransients(clipId, {
      loadAudioAsset: async () => {
        // The user trims the clip start while the analysis is still loading.
        if (store.clips.find((clip) => clip.id === clipId)?.startPpq === 0) trimClip(clipId, 3, 5);
        return asset as never;
      },
      detectOnsets: detectClicks,
    });

    expect(result).toBeNull();
    expect(store.clips.filter((clip) => clip.trackId === trackId)).toHaveLength(1);
  });
});
