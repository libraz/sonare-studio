import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addAudioClip,
  addAudioTrack,
  clearHistory,
  setClipWarp,
  sliceAudioClipAtTransients,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import type { WarpedClipSource } from '@/project/warp';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const SAMPLE_RATE = 1000;

/** 10 s mono asset with a short click at each listed second. */
function clickAsset(id: string, clicks: number[]) {
  const frames = 10 * SAMPLE_RATE;
  const channel = new Float32Array(frames);
  for (const seconds of clicks) {
    const at = Math.round(seconds * SAMPLE_RATE);
    channel.fill(1, at, at + 4);
  }
  return {
    meta: { id, name: `${id}.wav`, sampleRate: SAMPLE_RATE, numChannels: 1, numFrames: frames },
    channels: [channel],
  };
}

/** Rising edges of the clicks, in seconds of the analysed buffer. */
function detectClicks(samples: Float32Array, sampleRate: number): number[] {
  const onsets: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (samples[i] > 0.5 && (i === 0 || samples[i - 1] <= 0.5)) onsets.push(i / sampleRate);
  }
  return onsets;
}

/** Plays the source through the warp anchors by nearest-frame lookup. */
async function renderWarp(source: WarpedClipSource): Promise<Float32Array[]> {
  const { anchors } = source;
  return source.channels.map((channel) => {
    const out = new Float32Array(source.lengthFrames);
    for (let frame = 0; frame < out.length; frame++) {
      const next = anchors.findIndex((anchor) => anchor.warpSample > frame);
      const a = anchors[Math.max(0, (next < 0 ? anchors.length : next) - 1)];
      const b = anchors[next < 0 ? anchors.length - 1 : next];
      const span = b.warpSample - a.warpSample;
      const t = span > 0 ? (frame - a.warpSample) / span : 0;
      const sourceFrame = Math.round(a.sourceSample + (b.sourceSample - a.sourceSample) * t);
      out[frame] = channel[sourceFrame] ?? 0;
    }
    return out;
  });
}

describe('transient slicing reads the audible clip', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    installMockOpfs();
    setActivePinia(createPinia());
    store = useProjectStore();
    await store.init();
    clearHistory();
  });

  afterEach(() => {
    uninstallMockOpfs();
  });

  function sliceStarts(ids: number[]): number[] {
    return ids
      .map((id) => store.clips.find((clip) => clip.id === id)?.startPpq ?? Number.NaN)
      .sort((a, b) => a - b);
  }

  it('cuts a warped clip where each onset is heard', async () => {
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({ trackId, assetId: 'take', lengthPpq: 8, startPpq: 0 });
    // Source at 60 BPM under a 120 BPM project: source second s is heard at PPQ s.
    setClipWarp(clipId, { enabled: true, sourceBpm: 60 });
    const assets: Record<string, ReturnType<typeof clickAsset>> = {
      take: clickAsset('take', [2, 5]),
    };

    const ids = await sliceAudioClipAtTransients(clipId, {
      loadAudioAsset: async (id) => assets[id] as never,
      detectOnsets: detectClicks,
      renderWarp: async (source) => renderWarp(source),
    });

    const starts = sliceStarts(ids);
    expect(starts).toHaveLength(3);
    expect(starts[0]).toBe(0);
    expect(starts[1]).toBeCloseTo(2, 2);
    expect(starts[2]).toBeCloseTo(5, 2);
  });

  it('cuts a comped clip at the onsets of the take playing at each position', async () => {
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({ trackId, assetId: 'a', lengthPpq: 8, startPpq: 0 });
    store.clips = store.clips.map((clip) =>
      clip.id === clipId
        ? {
            ...clip,
            takes: [
              { assetId: 'a', name: 'Take 1' },
              { assetId: 'b', name: 'Take 2' },
            ],
            compSegments: [
              { startPpq: 0, takeIndex: 0 },
              { startPpq: 4, takeIndex: 1 },
            ],
          }
        : clip,
    );
    // 120 BPM: take a clicks at PPQ 2 and 6, take b at PPQ 1 and 5.2.
    const assets: Record<string, ReturnType<typeof clickAsset>> = {
      a: clickAsset('a', [1, 3]),
      b: clickAsset('b', [0.5, 2.6]),
    };

    const ids = await sliceAudioClipAtTransients(clipId, {
      loadAudioAsset: async (id) => assets[id] as never,
      detectOnsets: detectClicks,
    });

    const starts = sliceStarts(ids);
    expect(starts).toHaveLength(3);
    expect(starts[1]).toBeCloseTo(2, 2);
    expect(starts[2]).toBeCloseTo(5.2, 2);
  });
});
