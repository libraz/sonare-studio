import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedAudioAsset } from '@/persistence/assets';
import {
  addAudioClip,
  addAudioTrack,
  clearHistory,
  dropClipTakes,
  duplicateClip,
  redo,
  setClipActiveTake,
  setClipCompSegments,
  splitClip,
  trimClip,
  undo,
} from '@/project/commands';
import { flattenClipComp } from '@/project/comp-flatten';
import {
  audioClipSegments,
  type CompableClipFields,
  compSegmentsWithRange,
  sanitizeCompSegments,
  takeIndexAtPpq,
} from '@/project/comping';
import { useProjectStore } from '@/project/store';
import type { ClipTake } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('sanitizeCompSegments', () => {
  it('sorts by start, clamps negatives and pulls the first segment to the clip start', () => {
    expect(
      sanitizeCompSegments(
        [
          { startPpq: 3, takeIndex: 1 },
          { startPpq: 1, takeIndex: 0 },
        ],
        2,
        8,
      ),
    ).toEqual([
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 3, takeIndex: 1 },
    ]);
    expect(sanitizeCompSegments([{ startPpq: -2, takeIndex: 1 }], 2, 8)).toEqual([
      { startPpq: 0, takeIndex: 1 },
    ]);
  });

  it('drops segments with invalid starts or take indices', () => {
    expect(
      sanitizeCompSegments(
        [
          { startPpq: Number.NaN, takeIndex: 0 },
          { startPpq: Number.POSITIVE_INFINITY, takeIndex: 0 },
          { startPpq: 8, takeIndex: 0 }, // at the clip end (start must be < length)
          { startPpq: 9, takeIndex: 0 }, // beyond the clip end
          { startPpq: 2, takeIndex: -1 },
          { startPpq: 2, takeIndex: 0.5 },
          { startPpq: 2, takeIndex: 2 }, // out of range for two takes
          { startPpq: 1, takeIndex: 1 },
        ],
        2,
        8,
      ),
    ).toEqual([{ startPpq: 0, takeIndex: 1 }]);
    expect(sanitizeCompSegments([], 2, 8)).toEqual([]);
    expect(sanitizeCompSegments([{ startPpq: 1, takeIndex: 0 }], 0, 8)).toEqual([]);
  });

  it('lets the later entry win a tie at the same start', () => {
    expect(
      sanitizeCompSegments(
        [
          { startPpq: 2, takeIndex: 0 },
          { startPpq: 0, takeIndex: 0 },
          { startPpq: 2, takeIndex: 1 },
        ],
        2,
        8,
      ),
    ).toEqual([
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 2, takeIndex: 1 },
    ]);
  });

  it('merges adjacent same-take runs into one segment', () => {
    expect(
      sanitizeCompSegments(
        [
          { startPpq: 0, takeIndex: 1 },
          { startPpq: 2, takeIndex: 1 },
          { startPpq: 4, takeIndex: 0 },
          { startPpq: 6, takeIndex: 0 },
        ],
        2,
        8,
      ),
    ).toEqual([
      { startPpq: 0, takeIndex: 1 },
      { startPpq: 4, takeIndex: 0 },
    ]);
  });

  it('does not mutate the input segments', () => {
    const input = [{ startPpq: -1, takeIndex: 1 }];
    sanitizeCompSegments(input, 2, 8);
    expect(input).toEqual([{ startPpq: -1, takeIndex: 1 }]);
  });
});

describe('takeIndexAtPpq', () => {
  it('returns 0 for an empty selection', () => {
    expect(takeIndexAtPpq([], 3)).toBe(0);
  });

  it('picks the segment covering the position (segment starts are inclusive)', () => {
    const selection = [
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 2, takeIndex: 1 },
      { startPpq: 5, takeIndex: 2 },
    ];
    expect(takeIndexAtPpq(selection, 0)).toBe(0);
    expect(takeIndexAtPpq(selection, 1.999)).toBe(0);
    expect(takeIndexAtPpq(selection, 2)).toBe(1);
    expect(takeIndexAtPpq(selection, 4)).toBe(1);
    expect(takeIndexAtPpq(selection, 5)).toBe(2);
    expect(takeIndexAtPpq(selection, 100)).toBe(2);
  });
});

/** Builds a comping-shaped clip with three takes and overridable fields. */
function makeCompClip(overrides: Partial<CompableClipFields> = {}): CompableClipFields {
  return {
    lengthPpq: 8,
    sourceOffsetPpq: 0,
    takes: [
      { assetId: 'take-a', name: 'Take 1' },
      { assetId: 'take-b', name: 'Take 2' },
      { assetId: 'take-c', name: 'Take 3' },
    ],
    compSegments: [{ startPpq: 0, takeIndex: 0 }],
    ...overrides,
  };
}

describe('compSegmentsWithRange', () => {
  it('punches a take over a middle range and resumes the previous take', () => {
    expect(compSegmentsWithRange(makeCompClip(), 2, 4, 1)).toEqual([
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 2, takeIndex: 1 },
      { startPpq: 4, takeIndex: 0 },
    ]);
  });

  it('resumes the take that was playing at the range end', () => {
    const clip = makeCompClip({
      compSegments: [
        { startPpq: 0, takeIndex: 0 },
        { startPpq: 4, takeIndex: 1 },
      ],
    });
    expect(compSegmentsWithRange(clip, 2, 6, 2)).toEqual([
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 2, takeIndex: 2 },
      { startPpq: 6, takeIndex: 1 },
    ]);
  });

  it('omits the resume segment when the range reaches the clip end', () => {
    expect(compSegmentsWithRange(makeCompClip(), 2, 8, 1)).toEqual([
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 2, takeIndex: 1 },
    ]);
    // Ends beyond the clip are clamped to it.
    expect(compSegmentsWithRange(makeCompClip(), 2, 100, 1)).toEqual([
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 2, takeIndex: 1 },
    ]);
  });

  it('replaces the whole selection when the range covers the clip', () => {
    expect(compSegmentsWithRange(makeCompClip(), -5, 100, 2)).toEqual([
      { startPpq: 0, takeIndex: 2 },
    ]);
  });

  it('returns the current selection unchanged for an empty range', () => {
    expect(compSegmentsWithRange(makeCompClip(), 4, 4, 1)).toEqual([{ startPpq: 0, takeIndex: 0 }]);
    expect(compSegmentsWithRange(makeCompClip(), 5, 3, 1)).toEqual([{ startPpq: 0, takeIndex: 0 }]);
  });

  it('defaults to take 0 when the clip has no comp selection yet', () => {
    const clip = makeCompClip({ compSegments: undefined });
    expect(compSegmentsWithRange(clip, 2, 4, 1)).toEqual([
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 2, takeIndex: 1 },
      { startPpq: 4, takeIndex: 0 },
    ]);
  });

  it('merges away a punch that matches the surrounding take', () => {
    expect(compSegmentsWithRange(makeCompClip(), 2, 4, 0)).toEqual([{ startPpq: 0, takeIndex: 0 }]);
  });
});

describe('audioClipSegments', () => {
  it('expands a clip without takes into one segment over its own asset', () => {
    const clip: CompableClipFields = {
      lengthPpq: 4,
      sourceOffsetPpq: 2,
      assetId: 'asset-x',
      fadeInPpq: 0.5,
      fadeOutPpq: 1,
    };
    expect(audioClipSegments(clip)).toEqual([
      {
        assetId: 'asset-x',
        offsetPpq: 0,
        lengthPpq: 4,
        sourceOffsetPpq: 2,
        fadeInPpq: 0.5,
        fadeOutPpq: 1,
      },
    ]);
    // Absent fades default to 0.
    expect(audioClipSegments({ lengthPpq: 4, sourceOffsetPpq: 0, assetId: 'asset-x' })).toEqual([
      {
        assetId: 'asset-x',
        offsetPpq: 0,
        lengthPpq: 4,
        sourceOffsetPpq: 0,
        fadeInPpq: 0,
        fadeOutPpq: 0,
      },
    ]);
  });

  it('yields nothing for a clip without takes and without an asset', () => {
    expect(audioClipSegments({ lengthPpq: 4, sourceOffsetPpq: 0 })).toEqual([]);
  });

  it('plays take 0 throughout when takes exist without a comp selection', () => {
    const expected = [
      {
        assetId: 'take-a',
        offsetPpq: 0,
        lengthPpq: 8,
        sourceOffsetPpq: 1,
        fadeInPpq: 0,
        fadeOutPpq: 0,
      },
    ];
    expect(
      audioClipSegments(makeCompClip({ sourceOffsetPpq: 1, compSegments: undefined })),
    ).toEqual(expected);
    expect(audioClipSegments(makeCompClip({ sourceOffsetPpq: 1, compSegments: [] }))).toEqual(
      expected,
    );
  });

  it('slices a multi-segment comp with fades only at the clip edges', () => {
    const clip = makeCompClip({
      sourceOffsetPpq: 1,
      fadeInPpq: 0.5,
      fadeOutPpq: 0.25,
      compSegments: [
        { startPpq: 0, takeIndex: 0 },
        { startPpq: 2, takeIndex: 1, crossfadePpq: 0 },
        { startPpq: 5, takeIndex: 2, crossfadePpq: 0 },
      ],
    });
    expect(audioClipSegments(clip)).toEqual([
      {
        assetId: 'take-a',
        offsetPpq: 0,
        lengthPpq: 2,
        sourceOffsetPpq: 1,
        fadeInPpq: 0.5,
        fadeOutPpq: 0,
      },
      {
        assetId: 'take-b',
        offsetPpq: 2,
        lengthPpq: 3,
        sourceOffsetPpq: 3,
        fadeInPpq: 0,
        fadeOutPpq: 0,
      },
      {
        assetId: 'take-c',
        offsetPpq: 5,
        lengthPpq: 3,
        sourceOffsetPpq: 6,
        fadeInPpq: 0,
        fadeOutPpq: 0.25,
      },
    ]);
  });

  it('sanitizes a messy comp selection before expanding', () => {
    const clip = makeCompClip({
      compSegments: [
        { startPpq: 5, takeIndex: 1 },
        { startPpq: 5, takeIndex: 2, crossfadePpq: 0 },
        { startPpq: -1, takeIndex: 0 },
      ],
    });
    expect(audioClipSegments(clip)).toEqual([
      {
        assetId: 'take-a',
        offsetPpq: 0,
        lengthPpq: 5,
        sourceOffsetPpq: 0,
        fadeInPpq: 0,
        fadeOutPpq: 0,
      },
      {
        assetId: 'take-c',
        offsetPpq: 5,
        lengthPpq: 3,
        sourceOffsetPpq: 5,
        fadeInPpq: 0,
        fadeOutPpq: 0,
      },
    ]);
  });

  it('adds a short default crossfade around internal comp boundaries', () => {
    const clip = makeCompClip({
      compSegments: [
        { startPpq: 0, takeIndex: 0 },
        { startPpq: 2, takeIndex: 1 },
      ],
    });

    expect(audioClipSegments(clip)).toEqual([
      {
        assetId: 'take-a',
        offsetPpq: 0,
        lengthPpq: 2.01,
        sourceOffsetPpq: 0,
        fadeInPpq: 0,
        fadeOutPpq: 0.02,
      },
      {
        assetId: 'take-b',
        offsetPpq: 1.99,
        lengthPpq: 6.01,
        sourceOffsetPpq: 1.99,
        fadeInPpq: 0.02,
        fadeOutPpq: 0,
      },
    ]);
  });
});

/** Two recorded takes used by the command tests below. */
function twoTakes(): ClipTake[] {
  return [
    { assetId: 'take-a', name: 'Take 1' },
    { assetId: 'take-b', name: 'Take 2' },
  ];
}

describe('take and comping commands', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  /** Adds an audio clip with two takes on a fresh audio track. */
  async function addCompedClip(lengthPpq = 8): Promise<number> {
    const trackId = addAudioTrack({ name: 'Vox' });
    return addAudioClip({
      trackId,
      assetId: 'take-b',
      lengthPpq,
      name: 'Lead',
      takes: twoTakes(),
    });
  }

  const findClip = (clipId: number) => store.clips.find((c) => c.id === clipId);

  it('addAudioClip seeds takes and a single-segment comp on the active take', async () => {
    const trackId = addAudioTrack();
    const takes = twoTakes();
    const clipId = await addAudioClip({ trackId, assetId: 'take-b', lengthPpq: 8, takes });

    const clip = findClip(clipId);
    // The last take is active by default and owns the clip asset.
    expect(clip?.assetId).toBe('take-b');
    expect(clip?.takes).toEqual(twoTakes());
    expect(clip?.compSegments).toEqual([{ startPpq: 0, takeIndex: 1 }]);
    // The takes are copied, not aliased to the caller's array.
    expect(clip?.takes).not.toBe(takes);

    const explicit = await addAudioClip({
      trackId,
      assetId: 'take-a',
      startPpq: 16,
      lengthPpq: 8,
      takes: twoTakes(),
      activeTakeIndex: 0,
    });
    expect(findClip(explicit)?.compSegments).toEqual([{ startPpq: 0, takeIndex: 0 }]);
    expect(findClip(explicit)?.assetId).toBe('take-a');
  });

  it('addAudioClip treats an empty takes list as no takes', async () => {
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({ trackId, assetId: 'asset-x', lengthPpq: 8, takes: [] });
    expect(findClip(clipId)?.takes).toBeUndefined();
    expect(findClip(clipId)?.compSegments).toBeUndefined();
  });

  it('addAudioClip validates the active take index and asset', async () => {
    const trackId = addAudioTrack();
    const base = { trackId, assetId: 'take-b', lengthPpq: 8, takes: twoTakes() };
    await expect(addAudioClip({ ...base, activeTakeIndex: 2 })).rejects.toThrow(RangeError);
    await expect(addAudioClip({ ...base, activeTakeIndex: -1 })).rejects.toThrow(RangeError);
    await expect(addAudioClip({ ...base, activeTakeIndex: 0.5 })).rejects.toThrow(RangeError);
    // The clip asset must reference the active take's asset.
    await expect(addAudioClip({ ...base, activeTakeIndex: 0 })).rejects.toThrow(
      /active take asset/,
    );
    expect(store.clips.some((c) => c.kind === 'audio')).toBe(false);
  });

  it('addAudioClip with takes restores the takes metadata across undo/redo', async () => {
    const clipId = await addCompedClip();
    undo();
    expect(findClip(clipId)).toBeUndefined();
    redo();
    expect(findClip(clipId)?.takes).toEqual(twoTakes());
    expect(findClip(clipId)?.compSegments).toEqual([{ startPpq: 0, takeIndex: 1 }]);
  });

  it('setClipCompSegments sanitizes, rebases the clip asset and undoes/redoes', async () => {
    const clipId = await addCompedClip();
    setClipCompSegments(clipId, [
      { startPpq: 2, takeIndex: 1 },
      { startPpq: -1, takeIndex: 0 },
      { startPpq: 8, takeIndex: 1 }, // at the clip end: dropped
    ]);

    expect(findClip(clipId)?.compSegments).toEqual([
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 2, takeIndex: 1 },
    ]);
    // The clip asset follows the take selected at the clip start.
    expect(findClip(clipId)?.assetId).toBe('take-a');

    undo();
    expect(findClip(clipId)?.compSegments).toEqual([{ startPpq: 0, takeIndex: 1 }]);
    expect(findClip(clipId)?.assetId).toBe('take-b');

    redo();
    expect(findClip(clipId)?.compSegments).toEqual([
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 2, takeIndex: 1 },
    ]);
    expect(findClip(clipId)?.assetId).toBe('take-a');
  });

  it('duplicateClip preserves takes and comp selection metadata', async () => {
    const clipId = await addCompedClip();
    setClipCompSegments(clipId, [
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 3, takeIndex: 1 },
    ]);

    const copyId = duplicateClip(clipId, 16);
    const copy = findClip(copyId);

    expect(copy?.takes).toEqual(twoTakes());
    expect(copy?.compSegments).toEqual([
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 3, takeIndex: 1 },
    ]);
    expect(copy?.assetId).toBe('take-a');
  });

  it('splitClip partitions takes and comp selection metadata into both halves', async () => {
    const clipId = await addCompedClip();
    setClipCompSegments(clipId, [
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 3, takeIndex: 1 },
      { startPpq: 6, takeIndex: 0 },
    ]);

    const rightId = splitClip(clipId, 4);
    const left = findClip(clipId);
    const right = findClip(rightId);

    expect(left?.takes).toEqual(twoTakes());
    expect(left?.compSegments).toEqual([
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 3, takeIndex: 1 },
    ]);
    expect(left?.assetId).toBe('take-a');
    expect(right?.takes).toEqual(twoTakes());
    expect(right?.compSegments).toEqual([
      { startPpq: 0, takeIndex: 1 },
      { startPpq: 2, takeIndex: 0 },
    ]);
    expect(right?.assetId).toBe('take-b');
  });

  it('trimClip rebases takes and comp selection metadata to the trimmed window', async () => {
    const clipId = await addCompedClip();
    setClipCompSegments(clipId, [
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 3, takeIndex: 1 },
      { startPpq: 6, takeIndex: 0 },
    ]);

    trimClip(clipId, 2, 4);
    const trimmed = findClip(clipId);

    expect(trimmed?.takes).toEqual(twoTakes());
    expect(trimmed?.compSegments).toEqual([
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 1, takeIndex: 1 },
    ]);
    expect(trimmed?.assetId).toBe('take-a');
  });

  it('setClipCompSegments validates the clip and the selection', async () => {
    const trackId = addAudioTrack();
    const plain = await addAudioClip({ trackId, assetId: 'asset-x', lengthPpq: 8 });
    expect(() => setClipCompSegments(9999, [{ startPpq: 0, takeIndex: 0 }])).toThrow(RangeError);
    expect(() => setClipCompSegments(plain, [{ startPpq: 0, takeIndex: 0 }])).toThrow(/no takes/);

    const comped = await addCompedClip();
    expect(() => setClipCompSegments(comped, [])).toThrow(RangeError);
    // A selection where every segment is invalid must be rejected too.
    expect(() => setClipCompSegments(comped, [{ startPpq: 0, takeIndex: 5 }])).toThrow(RangeError);
  });

  it('setClipActiveTake selects one take for the whole clip, undoably', async () => {
    const clipId = await addCompedClip();
    setClipActiveTake(clipId, 0);
    expect(findClip(clipId)?.compSegments).toEqual([{ startPpq: 0, takeIndex: 0 }]);
    expect(findClip(clipId)?.assetId).toBe('take-a');

    undo();
    expect(findClip(clipId)?.compSegments).toEqual([{ startPpq: 0, takeIndex: 1 }]);
    expect(findClip(clipId)?.assetId).toBe('take-b');

    expect(() => setClipActiveTake(clipId, 5)).toThrow(RangeError);
  });

  it('dropClipTakes flattens a single-segment comp in place, undoably', async () => {
    const clipId = await addCompedClip();
    dropClipTakes(clipId);
    const flattened = findClip(clipId);
    expect(flattened?.takes).toBeUndefined();
    expect(flattened?.compSegments).toBeUndefined();
    expect(flattened?.assetId).toBe('take-b'); // keeps the selected take's asset

    undo();
    expect(findClip(clipId)?.takes).toEqual(twoTakes());
    expect(findClip(clipId)?.compSegments).toEqual([{ startPpq: 0, takeIndex: 1 }]);

    expect(() => dropClipTakes(9999)).toThrow(RangeError);
    redo();
    expect(() => dropClipTakes(clipId)).toThrow(/no takes/);
  });

  it('dropClipTakes requires a baked asset for multi-segment comps and rebases onto it', async () => {
    const clipId = await addCompedClip();
    setClipCompSegments(clipId, [
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 2, takeIndex: 1, crossfadePpq: 0 },
    ]);
    expect(() => dropClipTakes(clipId)).toThrow(/multi-segment/);

    dropClipTakes(clipId, 'baked-asset');
    const baked = findClip(clipId);
    expect(baked?.assetId).toBe('baked-asset');
    expect(baked?.sourceOffsetPpq).toBe(0); // the baked asset covers the clip window
    expect(baked?.takes).toBeUndefined();
    expect(baked?.compSegments).toBeUndefined();

    undo();
    const restored = findClip(clipId);
    expect(restored?.takes).toEqual(twoTakes());
    expect(restored?.compSegments).toEqual([
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 2, takeIndex: 1, crossfadePpq: 0 },
    ]);
    expect(restored?.assetId).toBe('take-a');

    redo();
    expect(findClip(clipId)?.assetId).toBe('baked-asset');
  });
});

describe('flattenClipComp', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  /** Builds a loaded asset at 4 Hz (1 PPQ = 2 frames at 120 BPM). */
  function makeLoadedAsset(id: string, channels: number[][]): LoadedAudioAsset {
    return {
      meta: {
        id,
        name: id,
        sampleRate: 4,
        numChannels: channels.length,
        numFrames: channels[0]?.length ?? 0,
      },
      channels: channels.map((values) => Float32Array.from(values)),
    };
  }

  /** Asset loader serving the two takes used below. */
  function makeLoader(assets: Record<string, LoadedAudioAsset>) {
    return vi.fn(async (assetId: string): Promise<LoadedAudioAsset> => {
      const asset = assets[assetId];
      if (!asset) throw new Error(`missing asset ${assetId}`);
      return asset;
    });
  }

  /** Adds a comped clip (two takes, take 0 then take 1 at PPQ 2) of length 4. */
  async function addMultiSegmentClip(): Promise<number> {
    const trackId = addAudioTrack({ name: 'Vox' });
    const clipId = await addAudioClip({
      trackId,
      assetId: 'take-b',
      lengthPpq: 4,
      name: 'Lead',
      takes: [
        { assetId: 'take-a', name: 'Take 1' },
        { assetId: 'take-b', name: 'Take 2' },
      ],
    });
    setClipCompSegments(clipId, [
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 2, takeIndex: 1 },
    ]);
    return clipId;
  }

  it('stitches a multi-segment comp into one asset and rebases the clip', async () => {
    const clipId = await addMultiSegmentClip();
    const loadAudioAsset = makeLoader({
      'take-a': makeLoadedAsset('take-a', [[1, 2, 3, 4, 5, 6, 7, 8]]),
      'take-b': makeLoadedAsset('take-b', [[101, 102, 103, 104, 105, 106, 107, 108]]),
    });
    const ingest = vi.fn(async () => ({ id: 'baked-asset' }));

    const bakedId = await flattenClipComp(clipId, { tempoBpm: 120, loadAudioAsset, ingest });
    expect(bakedId).toBe('baked-asset');
    expect(loadAudioAsset.mock.calls.map(([id]) => id)).toEqual(['take-a', 'take-b']);

    // Segment 1: take-a frames 0..4; segment 2: take-b frames 4..8 (source
    // offset 2 PPQ). Fades are clip fields and must not be baked.
    expect(ingest).toHaveBeenCalledTimes(1);
    const [channels, sampleRate, name] = ingest.mock.calls[0] as unknown as [
      Float32Array[],
      number,
      string,
    ];
    expect(sampleRate).toBe(4);
    expect(name).toBe('Lead (comp)');
    expect(channels).toHaveLength(1);
    expect(Array.from(channels[0])).toEqual([1, 2, 3, 4, 105, 106, 107, 108]);

    const clip = store.clips.find((c) => c.id === clipId);
    expect(clip?.assetId).toBe('baked-asset');
    expect(clip?.sourceOffsetPpq).toBe(0);
    expect(clip?.takes).toBeUndefined();
    expect(clip?.compSegments).toBeUndefined();

    // The clip rebase is one undoable edit.
    undo();
    const restored = store.clips.find((c) => c.id === clipId);
    expect(restored?.assetId).toBe('take-a');
    expect(restored?.takes).toHaveLength(2);
    expect(restored?.compSegments).toEqual([
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 2, takeIndex: 1 },
    ]);
  });

  it('feeds mono slices into every channel when takes mix channel counts', async () => {
    const clipId = await addMultiSegmentClip();
    const loadAudioAsset = makeLoader({
      'take-a': makeLoadedAsset('take-a', [[1, 2, 3, 4, 5, 6, 7, 8]]),
      'take-b': makeLoadedAsset('take-b', [
        [101, 102, 103, 104, 105, 106, 107, 108],
        [201, 202, 203, 204, 205, 206, 207, 208],
      ]),
    });
    const ingest = vi.fn(async () => ({ id: 'baked-asset' }));

    await flattenClipComp(clipId, { tempoBpm: 120, loadAudioAsset, ingest });
    const [channels] = ingest.mock.calls[0] as unknown as [Float32Array[]];
    expect(channels).toHaveLength(2);
    expect(Array.from(channels[0])).toEqual([1, 2, 3, 4, 105, 106, 107, 108]);
    expect(Array.from(channels[1])).toEqual([1, 2, 3, 4, 205, 206, 207, 208]);
  });

  it('skips the bake for single-segment comps and just drops the takes', async () => {
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({
      trackId,
      assetId: 'take-b',
      lengthPpq: 4,
      takes: [
        { assetId: 'take-a', name: 'Take 1' },
        { assetId: 'take-b', name: 'Take 2' },
      ],
    });
    const ingest = vi.fn(async () => ({ id: 'baked-asset' }));
    const loadAudioAsset = makeLoader({});

    const assetId = await flattenClipComp(clipId, { tempoBpm: 120, loadAudioAsset, ingest });
    expect(assetId).toBe('take-b');
    expect(ingest).not.toHaveBeenCalled();
    expect(loadAudioAsset).not.toHaveBeenCalled();
    const clip = store.clips.find((c) => c.id === clipId);
    expect(clip?.takes).toBeUndefined();
    expect(clip?.assetId).toBe('take-b');
  });

  it('rejects unknown clips and clips without takes', async () => {
    await expect(flattenClipComp(9999)).rejects.toThrow(RangeError);
    const trackId = addAudioTrack();
    const plain = await addAudioClip({ trackId, assetId: 'asset-x', lengthPpq: 4 });
    await expect(flattenClipComp(plain)).rejects.toThrow(/no takes/);
  });
});
