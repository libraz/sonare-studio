import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAudioAssetCache, saveAsset } from '@/persistence/assets';
import {
  addAudioClip,
  addAudioTrack,
  addTrack,
  clearHistory,
  duplicateClip,
  moveClip,
  redo,
  setClipFades,
  setClipWarp,
  splitClip,
  trimClip,
  undo,
} from '@/project/commands';
import { getProject, useProjectStore } from '@/project/store';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** Shape of the fake Project document this spec reads back. */
interface FakeDoc {
  tracks: Array<{ id: number; kind: number; name: string }>;
  clips: Array<{
    id: number;
    track_id: number;
    start_ppq: number;
    length_ppq: number;
    source_offset_ppq: number;
    gain: number;
    source_id: number;
    fade_in_ppq: number;
    fade_out_ppq: number;
  }>;
}

function readDoc(): FakeDoc {
  return JSON.parse(getProject().toJson()) as FakeDoc;
}

describe('audio track and clip commands', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    clearAudioAssetCache();
    await store.init();
  });

  afterEach(() => {
    uninstallMockOpfs();
    clearAudioAssetCache();
  });

  it('addTrack accepts a kind and addAudioTrack shortcuts it', () => {
    const a = addTrack({ name: 'Synth', kind: 'midi' });
    const b = addAudioTrack({ name: 'Vox' });
    expect(store.tracks.find((t) => t.id === a)?.kind).toBe('midi');
    expect(store.tracks.find((t) => t.id === b)?.kind).toBe('audio');
    // The Project stores the audio ordinal (0).
    const doc = readDoc();
    expect(doc.tracks.find((t) => t.id === b)?.kind).toBe(0);
    // Undoable like any track add.
    undo();
    expect(store.tracks.some((t) => t.id === b)).toBe(false);
    redo();
    expect(store.tracks.find((t) => t.id === b)?.kind).toBe('audio');
  });

  it('addAudioClip registers one source per asset and reuses it', async () => {
    const trackId = addAudioTrack({ name: 'Audio' });
    const first = await addAudioClip({
      trackId,
      assetId: 'asset-x',
      startPpq: 4,
      lengthPpq: 8,
      name: 'Take 1',
    });
    const second = await addAudioClip({ trackId, assetId: 'asset-x', startPpq: 16, lengthPpq: 8 });

    const mirrorFirst = store.clips.find((c) => c.id === first);
    expect(mirrorFirst).toMatchObject({
      trackId,
      kind: 'audio',
      assetId: 'asset-x',
      name: 'Take 1',
      startPpq: 4,
      lengthPpq: 8,
      sourceOffsetPpq: 0,
      gain: 1,
      notes: [],
    });
    expect(store.clips.find((c) => c.id === second)).toMatchObject({
      kind: 'audio',
      assetId: 'asset-x',
      startPpq: 16,
    });

    // Both clips share the source registered for the asset.
    const doc = readDoc();
    const docFirst = doc.clips.find((c) => c.id === first);
    const docSecond = doc.clips.find((c) => c.id === second);
    expect(docFirst?.source_id).toBeDefined();
    expect(docSecond?.source_id).toBe(docFirst?.source_id);
  });

  it('addAudioClip undo/redo reverts the whole command at once', async () => {
    const trackId = addAudioTrack();
    const first = await addAudioClip({ trackId, assetId: 'asset-x', lengthPpq: 8 });
    const second = await addAudioClip({ trackId, assetId: 'asset-x', startPpq: 8, lengthPpq: 8 });

    undo(); // removes the second clip (addClip + setClipSource path)
    expect(store.clips.some((c) => c.id === second)).toBe(false);
    expect(store.clips.some((c) => c.id === first)).toBe(true);
    expect(readDoc().clips.some((c) => c.id === second)).toBe(false);

    undo(); // removes the first clip (source registration path)
    expect(store.clips.some((c) => c.id === first)).toBe(false);

    redo();
    redo();
    expect(store.clips.find((c) => c.id === first)).toMatchObject({
      kind: 'audio',
      assetId: 'asset-x',
    });
    expect(store.clips.find((c) => c.id === second)).toMatchObject({
      kind: 'audio',
      assetId: 'asset-x',
    });
    const doc = readDoc();
    expect(doc.clips.find((c) => c.id === second)?.source_id).toBe(
      doc.clips.find((c) => c.id === first)?.source_id,
    );
  });

  it('re-registers the asset source when undo rolled the registration back', async () => {
    const trackId = addAudioTrack();
    const first = await addAudioClip({ trackId, assetId: 'asset-x', lengthPpq: 8 });
    const sourcesAfterFirst = getProject().sourceCount();
    undo(); // rolls the registration back
    expect(getProject().sourceCount()).toBe(sourcesAfterFirst - 1);
    const again = await addAudioClip({ trackId, assetId: 'asset-x', lengthPpq: 8 });
    expect(again).not.toBe(first);
    // A fresh source was registered (no dangling rebind to the undone one).
    expect(getProject().sourceCount()).toBe(sourcesAfterFirst);
    expect(store.clips.find((c) => c.id === again)).toMatchObject({ kind: 'audio' });
  });

  it('derives the default clip length from the asset duration at the tempo', async () => {
    installMockOpfs();
    // 24000 frames at 48 kHz = 0.5 s = 1 quarter note at 120 BPM.
    await saveAsset({ id: 'half-second', name: 'Hit', sampleRate: 48000 }, [
      new Float32Array(24000),
    ]);
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({ trackId, assetId: 'half-second' });
    expect(store.clips.find((c) => c.id === clipId)?.lengthPpq).toBeCloseTo(1, 10);
  });

  it('validates its inputs', async () => {
    const trackId = addAudioTrack();
    await expect(addAudioClip({ trackId: 9999, assetId: 'a', lengthPpq: 1 })).rejects.toThrow(
      RangeError,
    );
    await expect(addAudioClip({ trackId, assetId: '', lengthPpq: 1 })).rejects.toThrow(RangeError);
    await expect(addAudioClip({ trackId, assetId: 'a', lengthPpq: 0 })).rejects.toThrow(RangeError);
    await expect(
      addAudioClip({ trackId, assetId: 'a', lengthPpq: 1, startPpq: -1 }),
    ).rejects.toThrow(RangeError);
    await expect(addAudioClip({ trackId, assetId: 'a', lengthPpq: 1, gain: -1 })).rejects.toThrow(
      RangeError,
    );
  });

  it('setClipFades writes the Project and mirrors the values, undoably', async () => {
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({ trackId, assetId: 'asset-x', lengthPpq: 8 });
    setClipFades(clipId, 0.5, 2);

    expect(store.clips.find((c) => c.id === clipId)).toMatchObject({
      fadeInPpq: 0.5,
      fadeOutPpq: 2,
    });
    expect(readDoc().clips.find((c) => c.id === clipId)).toMatchObject({
      fade_in_ppq: 0.5,
      fade_out_ppq: 2,
    });

    undo();
    const reverted = store.clips.find((c) => c.id === clipId);
    expect(reverted?.fadeInPpq).toBeUndefined();
    expect(reverted?.fadeOutPpq).toBeUndefined();

    redo();
    expect(store.clips.find((c) => c.id === clipId)).toMatchObject({
      fadeInPpq: 0.5,
      fadeOutPpq: 2,
    });

    // Clearing fades drops the mirror fields again.
    setClipFades(clipId);
    const cleared = store.clips.find((c) => c.id === clipId);
    expect(cleared?.fadeInPpq).toBeUndefined();
    expect(cleared?.fadeOutPpq).toBeUndefined();

    expect(() => setClipFades(clipId, -1)).toThrow(RangeError);
    expect(() => setClipFades(9999, 1)).toThrow(RangeError);
  });

  it('setClipWarp stores sanitized warp on the mirror, undoably', async () => {
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({ trackId, assetId: 'asset-x', lengthPpq: 8 });
    setClipWarp(clipId, {
      enabled: true,
      sourceBpm: 95,
      anchors: [
        { ppq: 6, sourceSeconds: 3 }, // unsorted on purpose
        { ppq: 2, sourceSeconds: 1 },
        { ppq: 8, sourceSeconds: 4 }, // on the window edge: dropped
        { ppq: -1, sourceSeconds: 1 }, // outside the window: dropped
        { ppq: 4, sourceSeconds: Number.NaN }, // non-finite: dropped
      ],
    });
    expect(store.clips.find((c) => c.id === clipId)?.warp).toEqual({
      enabled: true,
      sourceBpm: 95,
      anchors: [
        { ppq: 2, sourceSeconds: 1 },
        { ppq: 6, sourceSeconds: 3 },
      ],
    });

    undo();
    expect(store.clips.find((c) => c.id === clipId)?.warp).toBeUndefined();
    redo();
    expect(store.clips.find((c) => c.id === clipId)?.warp).toMatchObject({
      enabled: true,
      sourceBpm: 95,
    });

    // null clears the warp state, undoably too.
    setClipWarp(clipId, null);
    expect(store.clips.find((c) => c.id === clipId)?.warp).toBeUndefined();
    undo();
    expect(store.clips.find((c) => c.id === clipId)?.warp).toMatchObject({ sourceBpm: 95 });
  });

  it('setClipWarp omits the anchors field when none survive sanitizing', async () => {
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({ trackId, assetId: 'asset-x', lengthPpq: 8 });
    setClipWarp(clipId, {
      enabled: false,
      sourceBpm: 100,
      anchors: [{ ppq: 99, sourceSeconds: 1 }],
    });
    const warp = store.clips.find((c) => c.id === clipId)?.warp;
    expect(warp).toEqual({ enabled: false, sourceBpm: 100 });
    expect(warp !== undefined && 'anchors' in warp).toBe(false);
  });

  it('setClipWarp validates its inputs', async () => {
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({ trackId, assetId: 'asset-x', lengthPpq: 8 });
    expect(() => setClipWarp(9999, { enabled: true, sourceBpm: 120 })).toThrow(RangeError);
    // The default project ships one MIDI clip; warp is audio-only.
    const midiClip = store.clips.find((c) => (c.kind ?? 'midi') === 'midi');
    expect(midiClip).toBeDefined();
    expect(() =>
      setClipWarp((midiClip as { id: number }).id, { enabled: true, sourceBpm: 120 }),
    ).toThrow(RangeError);
    expect(() => setClipWarp(clipId, { enabled: true, sourceBpm: 0 })).toThrow(RangeError);
    expect(() => setClipWarp(clipId, { enabled: true, sourceBpm: -120 })).toThrow(RangeError);
    expect(() => setClipWarp(clipId, { enabled: true, sourceBpm: Number.NaN })).toThrow(RangeError);
    // Failed validation leaves the clip untouched.
    expect(store.clips.find((c) => c.id === clipId)?.warp).toBeUndefined();
  });
  it('move and trim keep the audio metadata on the mirror', async () => {
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({ trackId, assetId: 'asset-x', lengthPpq: 8 });
    moveClip(clipId, 16);
    expect(store.clips.find((c) => c.id === clipId)).toMatchObject({
      startPpq: 16,
      kind: 'audio',
      assetId: 'asset-x',
    });
    trimClip(clipId, 18, 4);
    expect(store.clips.find((c) => c.id === clipId)).toMatchObject({
      startPpq: 18,
      lengthPpq: 4,
      sourceOffsetPpq: 2,
      kind: 'audio',
      assetId: 'asset-x',
    });
    undo();
    undo();
    expect(store.clips.find((c) => c.id === clipId)).toMatchObject({
      startPpq: 0,
      lengthPpq: 8,
      kind: 'audio',
      assetId: 'asset-x',
    });
  });

  it('duplicate copies the audio metadata onto the copy', async () => {
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({
      trackId,
      assetId: 'asset-x',
      lengthPpq: 8,
      name: 'Take',
    });
    const copyId = duplicateClip(clipId, 32);
    expect(store.clips.find((c) => c.id === copyId)).toMatchObject({
      name: 'Take',
      startPpq: 32,
      kind: 'audio',
      assetId: 'asset-x',
    });
    // The copy shares the source.
    const doc = readDoc();
    expect(doc.clips.find((c) => c.id === copyId)?.source_id).toBe(
      doc.clips.find((c) => c.id === clipId)?.source_id,
    );
  });

  it('split keeps the audio metadata on both halves and moves the fade-out', async () => {
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({ trackId, assetId: 'asset-x', lengthPpq: 8 });
    setClipFades(clipId, 1, 1);
    const rightId = splitClip(clipId, 6);

    const left = store.clips.find((c) => c.id === clipId);
    const right = store.clips.find((c) => c.id === rightId);
    expect(left).toMatchObject({ lengthPpq: 6, kind: 'audio', assetId: 'asset-x' });
    expect(right).toMatchObject({
      startPpq: 6,
      lengthPpq: 2,
      sourceOffsetPpq: 6,
      kind: 'audio',
      assetId: 'asset-x',
    });
    expect(left?.fadeInPpq).toBe(1);
    expect(left?.fadeOutPpq).toBeUndefined();
    expect(right?.fadeInPpq).toBeUndefined();
    expect(right?.fadeOutPpq).toBe(1);

    undo();
    expect(store.clips.find((c) => c.id === clipId)).toMatchObject({
      lengthPpq: 8,
      fadeInPpq: 1,
      fadeOutPpq: 1,
    });
    expect(store.clips.some((c) => c.id === rightId)).toBe(false);
  });
});
