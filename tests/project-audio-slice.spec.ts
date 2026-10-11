import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN_SLICE_PPQ, quantizeSlices, transientCutsPpq } from '@/project/audio-slice';
import {
  addAudioClip,
  addAudioTrack,
  clearHistory,
  setClipLoop,
  sliceAudioClipAtTransients,
  undo,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { normalizeTempoMap } from '@/project/tempo-map';
import { en } from '@/ui/i18n/en';
import { ja } from '@/ui/i18n/ja';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

const wasmModule = vi.hoisted(() => ({
  current: undefined as undefined | Record<string, unknown>,
}));

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  wasmModule.current = fakeModule as unknown as Record<string, unknown>;
  return { ensureWasm: async () => wasmModule.current };
});

/** 120 BPM: one quarter note = 0.5 s, so PPQ and seconds map 2:1. */
const tempo = normalizeTempoMap([{ startPpq: 0, bpm: 120 }], 120);

describe('transient cuts', () => {
  it('maps onset seconds to timeline positions inside the clip window', () => {
    const clip = { startPpq: 4, lengthPpq: 4, sourceOffsetPpq: 0 };

    // Source starts at timeline 4 (offset 0), so 1 s = 2 PPQ later.
    expect(transientCutsPpq([1, 1.5], clip, tempo)).toEqual([6, 7]);
  });

  it('honours the source offset of a trimmed clip', () => {
    // The clip window starts 2 PPQ (1 s) into the asset, at timeline 4.
    const clip = { startPpq: 4, lengthPpq: 4, sourceOffsetPpq: 2 };

    // Onsets before the window are outside it; 1.5 s lands at timeline 5.
    expect(transientCutsPpq([0.5, 1.5], clip, tempo)).toEqual([5]);
  });

  it('drops onsets at the clip edges and cuts too close together', () => {
    const clip = { startPpq: 0, lengthPpq: 4, sourceOffsetPpq: 0 };

    expect(transientCutsPpq([0, 0.001, 1, 1.0001, 1.999], clip, tempo)).toEqual([2]);
  });
});

describe('slice quantization', () => {
  const snapHalf = (ppq: number) => Math.round(ppq / 0.5) * 0.5;

  it('moves slices to the grid and closes the gaps between them', () => {
    const placed = quantizeSlices(
      [
        { startPpq: 0, lengthPpq: 0.55 },
        { startPpq: 0.55, lengthPpq: 0.6 },
        { startPpq: 1.15, lengthPpq: 0.85 },
      ],
      snapHalf,
    );

    expect(placed).toEqual([
      { startPpq: 0, lengthPpq: 0.5 },
      { startPpq: 0.5, lengthPpq: 0.5 },
      { startPpq: 1, lengthPpq: 0.85 },
    ]);
  });

  it('never lets a slice overtake its predecessor', () => {
    const placed = quantizeSlices(
      [
        { startPpq: 0.4, lengthPpq: 0.2 },
        { startPpq: 0.45, lengthPpq: 0.2 },
      ],
      snapHalf,
    );

    expect(placed[0].startPpq).toBe(0.5);
    expect(placed[1].startPpq).toBeGreaterThanOrEqual(0.5 + MIN_SLICE_PPQ);
  });

  it('does not claim source material a slice does not have', () => {
    const placed = quantizeSlices(
      [
        { startPpq: 0, lengthPpq: 0.4, maxLengthPpq: 0.3 },
        { startPpq: 0.9, lengthPpq: 2, maxLengthPpq: 1 },
      ],
      snapHalf,
    );

    expect(placed[0].lengthPpq).toBeCloseTo(0.3);
    expect(placed[1].lengthPpq).toBeCloseTo(1);
  });
});

describe('sliceAudioClipAtTransients', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    installMockOpfs();
    setActivePinia(createPinia());
    store = useProjectStore();
    await store.init();
    clearHistory();
  });

  /** Stub asset: 4 s of silence at 48 kHz (8 PPQ at 120 BPM). */
  const loadAudioAsset = async () => ({
    channels: [new Float32Array(48000 * 4)],
    meta: { numFrames: 48000 * 4, sampleRate: 48000, channels: 1, name: 'take' },
  });

  it('cuts the clip at every detected transient in one undoable edit', async () => {
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({ trackId, assetId: 'take', lengthPpq: 8, startPpq: 0 });

    const ids = await sliceAudioClipAtTransients(clipId, {
      loadAudioAsset: loadAudioAsset as never,
      detectOnsets: () => [1, 2, 3],
    });

    expect(ids).toHaveLength(4);
    const starts = ids
      .map((id) => store.clips.find((clip) => clip.id === id)?.startPpq)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(starts).toEqual([0, 2, 4, 6]);

    expect(undo()).toBe(true);
    expect(store.clips.filter((clip) => clip.trackId === trackId)).toHaveLength(1);
    uninstallMockOpfs();
  });

  it('snaps the slices to the grid and closes their lengths when asked', async () => {
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({ trackId, assetId: 'take', lengthPpq: 8, startPpq: 0 });

    const ids = await sliceAudioClipAtTransients(clipId, {
      quantize: true,
      snap: (ppq) => Math.round(ppq),
      loadAudioAsset: loadAudioAsset as never,
      // 1.1 s = PPQ 2.2 and 2.6 s = PPQ 5.2: both played slightly late.
      detectOnsets: () => [1.1, 2.6],
    });

    const slices = ids.map((id) => store.clips.find((clip) => clip.id === id));
    expect(slices.map((clip) => clip?.startPpq)).toEqual([0, 2, 5]);
    // The first two slices close up to the next slice; the tail keeps its own.
    expect(slices[0]?.lengthPpq).toBeCloseTo(2);
    expect(slices[1]?.lengthPpq).toBeCloseTo(3);
    uninstallMockOpfs();
  });

  it('leaves the clip alone when nothing is detected', async () => {
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({ trackId, assetId: 'take', lengthPpq: 8 });

    const ids = await sliceAudioClipAtTransients(clipId, {
      loadAudioAsset: loadAudioAsset as never,
      detectOnsets: () => [],
    });

    expect(ids).toEqual([clipId]);
    expect(store.clips.filter((clip) => clip.trackId === trackId)).toHaveLength(1);
    uninstallMockOpfs();
  });

  it('refuses looping clips, which cannot be split', async () => {
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({ trackId, assetId: 'take', lengthPpq: 8 });
    setClipLoop(clipId, true, 4);

    await expect(
      sliceAudioClipAtTransients(clipId, {
        loadAudioAsset: loadAudioAsset as never,
        detectOnsets: () => [1],
      }),
    ).rejects.toThrow();
    uninstallMockOpfs();
  });
});

describe('transient slice entry points', () => {
  const arrangementView = readFileSync(
    resolve(process.cwd(), 'src/components/arrangement/ArrangementView.vue'),
    'utf8',
  );

  it('offers plain and quantizing slicing for unlooped audio clips', () => {
    expect(arrangementView).toContain("id: 'slice-transients'");
    expect(arrangementView).toContain("id: 'slice-transients-quantize'");
    expect(arrangementView).toContain(
      'const sliceBlocked = firstBlock(\n    frozenBlock,\n    [!audio, why.audioClipsOnly],\n    [clip.loopEnabled, why.loopOn],\n  );',
    );
    expect(arrangementView).toContain('disabledReason: sliceBlocked,');
    expect(arrangementView).toContain('runTransientSlice(clip.id, true)');
  });

  it('passes the arrangement grid snap into the command', () => {
    expect(arrangementView).toContain('snap: snapArrangementPpq,');
  });

  it('labels the actions and the empty result in every locale', () => {
    for (const bundle of [en, ja]) {
      expect(bundle.shell.arrangement.clipActions.sliceTransients.length).toBeGreaterThan(0);
      expect(bundle.shell.arrangement.clipActions.sliceTransientsQuantize.length).toBeGreaterThan(
        0,
      );
      expect(bundle.shell.arrangement.clipActions.sliceNoTransients.length).toBeGreaterThan(0);
    }
  });
});
