import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAudioAssetCache, loadAsset, saveAsset } from '@/persistence/assets';
import {
  addAudioClip,
  addAudioTrack,
  clearHistory,
  splitAudioClipToStems,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

const wasmModule = vi.hoisted(() => ({
  current: undefined as undefined | Record<string, unknown>,
}));

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const real = await import('@libraz/libsonare');
  await real.init();
  wasmModule.current = {
    ...(createFakeWasmModule() as unknown as Record<string, unknown>),
    hpss: real.hpss,
    phaseVocoder: real.phaseVocoder,
  };
  return { ensureWasm: async () => wasmModule.current };
});

const SAMPLE_RATE = 22050;
const FRAMES = SAMPLE_RATE / 2;

/** A held tone with a short noise burst, so both bands have something to claim. */
function toneWithBurst(): Float32Array {
  const samples = new Float32Array(FRAMES);
  let seed = 12345;
  for (let i = 0; i < FRAMES; i++) {
    samples[i] = Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * 0.4;
    if (i > 4000 && i < 4160) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      samples[i] += (seed / 0xffffffff - 0.5) * 1.2;
    }
  }
  return samples;
}

function rms(values: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i] * values[i];
  return Math.sqrt(sum / values.length);
}

describe('stem separation with the real separator', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    clearAudioAssetCache();
    await store.init();
    installMockOpfs();
  });

  afterEach(() => {
    uninstallMockOpfs();
    clearAudioAssetCache();
  });

  it('lays down audible stems that sum back to the source', async () => {
    const source = toneWithBurst();
    await saveAsset({ id: 'real-source', name: 'Real Source', sampleRate: SAMPLE_RATE }, [source]);
    const trackId = addAudioTrack({ name: 'Audio' });
    // One PPQ is half a second at the default 120 BPM.
    const clipId = await addAudioClip({
      trackId,
      assetId: 'real-source',
      startPpq: 0,
      lengthPpq: 1,
      name: 'Real',
    });

    const stemClipIds = await splitAudioClipToStems(clipId);
    expect(stemClipIds).toHaveLength(3);
    const stems = await Promise.all(
      stemClipIds.map(async (id) => {
        const assetId = store.clips.find((clip) => clip.id === id)?.assetId ?? '';
        return (await loadAsset(assetId)).channels[0];
      }),
    );

    const difference = new Float32Array(FRAMES);
    for (let i = 0; i < FRAMES; i++) {
      difference[i] = source[i] - stems.reduce((sum, stem) => sum + stem[i], 0);
    }
    expect(rms(difference) / rms(source)).toBeLessThan(0.01);
    // The held tone is the harmonic band's; it keeps nearly all of its level.
    expect(rms(stems[0])).toBeGreaterThan(0.9 * rms(source));
    // Every band, the residual included, carries signal rather than silence.
    for (const stem of stems) expect(rms(stem)).toBeGreaterThan(1e-4);
  });
});
