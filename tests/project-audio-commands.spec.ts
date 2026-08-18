import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAudioAssetCache, listAssets, loadAsset, saveAsset } from '@/persistence/assets';
import { STEM_KINDS } from '@/project/audio-stems';
import {
  addAudioClip,
  addAudioTrack,
  addTrack,
  clearHistory,
  consolidateAudioClips,
  deleteClip,
  duplicateClip,
  extractMelodyFromAudioClip,
  moveClip,
  redo,
  replaceAudioClipAsset,
  setClipCompSegments,
  setClipFades,
  setClipLoop,
  setClipWarp,
  setTempoSegments,
  setTrackRecordInputChannel,
  splitAudioClipToStems,
  splitClip,
  trimClip,
  undo,
} from '@/project/commands';
import { isExternalStemRole } from '@/project/external-stems';
import {
  loadProjectDocument,
  type ProjectDocument,
  serializeProject,
} from '@/project/serialization';
import { getProject, useProjectStore } from '@/project/store';
import { warpSourceSecondsAt } from '@/project/warp';
import { installMockOpfs, MemoryFileHandle, uninstallMockOpfs } from './opfs-mock';

const wasmModule = vi.hoisted(() => ({
  current: undefined as undefined | Record<string, unknown>,
}));

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  wasmModule.current = fakeModule as unknown as Record<string, unknown>;
  return { ensureWasm: async () => wasmModule.current };
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
    warp_ref_id?: number;
    warp_mode?: number;
  }>;
  warp_maps?: Array<{
    id: number;
    name?: string;
    anchors: Array<{ warpSample: number; sourceSample: number }>;
  }>;
  midi_content: Record<string, Array<{ ppq: number; data0: number; data1: number }>>;
}

function readDoc(): FakeDoc {
  return JSON.parse(getProject().toJson()) as FakeDoc;
}

function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushPromises(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Reads the metadata strings the Project stores for a clip's audio source. */
function sourceMetadata(clipId: number): { contentHash: string; externalStemRole: string } {
  const sourceId = readDoc().clips.find((clip) => clip.id === clipId)?.source_id ?? 0;
  const source = (
    getProject() as unknown as {
      sourceByIndex(index: number): { contentHash: string; externalStemRole: string };
    }
  ).sourceByIndex(sourceId - 1);
  return { contentHash: source.contentHash, externalStemRole: source.externalStemRole };
}

/** The name each band is laid down under: the source clip name plus the band. */
function bandNames(baseName: string): string[] {
  return STEM_KINDS.map((kind) => `${baseName} ${kind}`);
}

/**
 * Lays down an audio clip over a four-frame asset and installs a separator that
 * scales each band differently, so the split stores three distinct assets.
 *
 * @param name Source clip name the stem names are derived from.
 * @returns Id of the audio clip to split (starts at 4 PPQ, gain 0.75).
 */
async function layDownStemSource(name: string): Promise<number> {
  installMockOpfs();
  await saveAsset({ id: 'stem-source', name: 'Stem Source', sampleRate: 4 }, [
    new Float32Array([1, 2, 3, 4]),
  ]);
  const trackId = addAudioTrack({ name: 'Audio' });
  const clipId = await addAudioClip({
    trackId,
    assetId: 'stem-source',
    startPpq: 4,
    lengthPpq: 2,
    gain: 0.75,
    name,
  });
  Object.assign(wasmModule.current ?? {}, {
    hpssWithResidual: (samples: Float32Array, sampleRate?: number) => ({
      harmonic: samples.map((value) => value * 2),
      percussive: samples.map((value) => value * 3),
      residual: samples.map((value) => value * 4),
      sampleRate: sampleRate ?? 4,
    }),
  });
  return clipId;
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

  it('sets audio track record input channels undoably', () => {
    const midiTrackId = addTrack({ name: 'Synth', kind: 'midi' });
    const audioTrackId = addAudioTrack({ name: 'Mic' });

    setTrackRecordInputChannel(audioTrackId, 3);
    expect(store.tracks.find((track) => track.id === audioTrackId)?.recordInputChannel).toBe(3);

    undo();
    expect(
      store.tracks.find((track) => track.id === audioTrackId)?.recordInputChannel,
    ).toBeUndefined();

    redo();
    expect(store.tracks.find((track) => track.id === audioTrackId)?.recordInputChannel).toBe(3);

    setTrackRecordInputChannel(audioTrackId, null);
    expect(
      store.tracks.find((track) => track.id === audioTrackId)?.recordInputChannel,
    ).toBeUndefined();
    expect(() => setTrackRecordInputChannel(midiTrackId, 0)).toThrow(/audio tracks/);
    expect(() => setTrackRecordInputChannel(audioTrackId, -1)).toThrow(/non-negative integer/);
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

  it('rolls back a created audio clip when rebinding its known source throws', async () => {
    const trackId = addAudioTrack({ name: 'Audio' });
    await addAudioClip({ trackId, assetId: 'asset-x', lengthPpq: 8 });
    const before = getProject().toJson();
    const clipCount = store.clips.length;
    const sourceSpy = vi.spyOn(getProject(), 'setClipSource').mockImplementation(() => {
      throw Error('source binding failed');
    });

    await expect(
      addAudioClip({ trackId, assetId: 'asset-x', startPpq: 8, lengthPpq: 8 }),
    ).rejects.toThrow('source binding failed');
    sourceSpy.mockRestore();

    expect(getProject().toJson()).toBe(before);
    expect(store.clips).toHaveLength(clipCount);
  });

  it('addAudioClip can seed preserved audio clip attributes when rebasing an asset', async () => {
    const trackId = addAudioTrack({ name: 'Audio' });
    const clipId = await addAudioClip({
      trackId,
      assetId: 'edited-asset',
      startPpq: 4,
      lengthPpq: 8,
      sourceOffsetPpq: 1.5,
      gain: 0.75,
      fadeInPpq: 0.25,
      fadeOutPpq: 0.5,
      loopEnabled: true,
      loopLengthPpq: 2,
      warp: { enabled: true, sourceBpm: 96, anchors: [{ ppq: 2, sourceSeconds: 1 }] },
    });

    expect(store.clips.find((c) => c.id === clipId)).toMatchObject({
      trackId,
      kind: 'audio',
      assetId: 'edited-asset',
      startPpq: 4,
      lengthPpq: 8,
      sourceOffsetPpq: 1.5,
      gain: 0.75,
      fadeInPpq: 0.25,
      fadeOutPpq: 0.5,
      loopEnabled: true,
      loopLengthPpq: 2,
      warp: { enabled: true, sourceBpm: 96, anchors: [{ ppq: 2, sourceSeconds: 1 }] },
    });
    const docClip = readDoc().clips.find((clip) => clip.id === clipId);
    expect(docClip).toMatchObject({
      source_offset_ppq: 1.5,
      fade_in_ppq: 0.25,
      fade_out_ppq: 0.5,
      warp_ref_id: clipId,
      warp_mode: 2,
    });
    expect(readDoc().warp_maps?.map((map) => map.id)).toEqual([clipId]);
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

  it('derives the default clip length from the tempo-map position', async () => {
    installMockOpfs();
    await saveAsset({ id: 'one-second', name: 'Hit', sampleRate: 4 }, [new Float32Array(4)]);
    setTempoSegments([
      { startPpq: 0, bpm: 120 },
      { startPpq: 4, bpm: 60 },
    ]);
    const trackId = addAudioTrack();

    const clipId = await addAudioClip({ trackId, assetId: 'one-second', startPpq: 4 });

    // One second at the 60 BPM segment occupies one quarter note, not two.
    expect(store.clips.find((clip) => clip.id === clipId)?.lengthPpq).toBeCloseTo(1, 10);
  });

  it('extracts audio melody with detected-key pitch quantize and snap-grid rhythm quantize', async () => {
    installMockOpfs();
    await saveAsset({ id: 'melody-source', name: 'Melody', sampleRate: 48000 }, [
      new Float32Array(96000).fill(0.25),
    ]);
    const analyzeMelody = vi.fn(() => ({
      points: [
        { time: 0.12, frequency: midiToHz(66), confidence: 1 },
        { time: 0.38, frequency: 0, confidence: 0 },
      ],
    }));
    const detectKey = vi.fn(() => ({ name: 'C major' }));
    const scaleQuantizeMidi = vi.fn((_root: number, _modeMask: number, midi: number) =>
      midi === 66 ? 65 : midi,
    );
    Object.assign(wasmModule.current ?? {}, { analyzeMelody, detectKey, scaleQuantizeMidi });

    const trackId = addAudioTrack({ name: 'Audio' });
    const clipId = await addAudioClip({ trackId, assetId: 'melody-source', lengthPpq: 4 });
    store.snapEnabled = true;
    store.snapDivision = 8; // eighth-note grid = 0.5 PPQ

    const midiClipId = await extractMelodyFromAudioClip(clipId);

    expect(midiClipId).not.toBe(-1);
    expect(detectKey).not.toHaveBeenCalled();
    expect(scaleQuantizeMidi).not.toHaveBeenCalled();
    const midiEvents = readDoc().midi_content[String(midiClipId)];
    expect(midiEvents.map((event) => event.ppq)).toEqual([0, 1]);
    expect(midiEvents.map((event) => (event.data0 >>> 8) & 0x7f)).toEqual([66, 66]);
  });

  it('consolidates audio clips into one baked asset with gaps, gain and fades', async () => {
    installMockOpfs();
    await saveAsset({ id: 'clip-a', name: 'A', sampleRate: 4 }, [new Float32Array([1, 1, 1, 1])]);
    await saveAsset({ id: 'clip-b', name: 'B', sampleRate: 4 }, [new Float32Array([2, 2, 2, 2])]);
    const trackId = addAudioTrack({ name: 'Audio' });
    const first = await addAudioClip({
      trackId,
      assetId: 'clip-a',
      startPpq: 0,
      lengthPpq: 1,
      gain: 0.5,
      fadeInPpq: 0.5,
      name: 'Part A',
    });
    const second = await addAudioClip({
      trackId,
      assetId: 'clip-b',
      startPpq: 2,
      lengthPpq: 1,
      sourceOffsetPpq: 0.5,
      name: 'Part B',
    });

    const consolidatedId = await consolidateAudioClips([first, second], { tempoBpm: 60 });

    expect(store.clips.some((clip) => clip.id === first || clip.id === second)).toBe(false);
    const consolidated = store.clips.find((clip) => clip.id === consolidatedId);
    expect(consolidated).toMatchObject({
      trackId,
      kind: 'audio',
      startPpq: 0,
      lengthPpq: 3,
      sourceOffsetPpq: 0,
      gain: 1,
      name: 'Part A (consolidated)',
    });
    expect(consolidated?.assetId).toBeDefined();
    const baked = await loadAsset(consolidated?.assetId ?? '');
    expect(baked.meta.sampleRate).toBe(4);
    expect(Array.from(baked.channels[0])).toEqual([0, 0.25, 0.5, 0.5, 0, 0, 0, 0, 2, 2, 0, 0]);

    undo();
    expect(store.clips.some((clip) => clip.id === consolidatedId)).toBe(false);
    expect(store.clips.find((clip) => clip.id === first)?.assetId).toBe('clip-a');
    expect(store.clips.find((clip) => clip.id === second)?.assetId).toBe('clip-b');
  });

  it('mixes overlapping audio clips when consolidating', async () => {
    installMockOpfs();
    await saveAsset({ id: 'overlap-a', name: 'A', sampleRate: 4 }, [
      new Float32Array([1, 1, 1, 1]),
    ]);
    await saveAsset({ id: 'overlap-b', name: 'B', sampleRate: 4 }, [
      new Float32Array([2, 2, 2, 2]),
    ]);
    const trackId = addAudioTrack({ name: 'Audio' });
    const first = await addAudioClip({ trackId, assetId: 'overlap-a', startPpq: 0, lengthPpq: 1 });
    const second = await addAudioClip({
      trackId,
      assetId: 'overlap-b',
      startPpq: 0.5,
      lengthPpq: 1,
    });

    const consolidatedId = await consolidateAudioClips([first, second], { tempoBpm: 60 });
    const consolidated = store.clips.find((clip) => clip.id === consolidatedId);
    const baked = await loadAsset(consolidated?.assetId ?? '');

    expect(Array.from(baked.channels[0])).toEqual([1, 1, 3, 3, 2, 2]);
  });

  it('skips applying a consolidated asset when source clips changed during ingest', async () => {
    installMockOpfs();
    await saveAsset({ id: 'stale-a', name: 'A', sampleRate: 4 }, [new Float32Array([1, 1])]);
    await saveAsset({ id: 'stale-b', name: 'B', sampleRate: 4 }, [new Float32Array([2, 2])]);
    const trackId = addAudioTrack({ name: 'Audio' });
    const first = await addAudioClip({ trackId, assetId: 'stale-a', startPpq: 0, lengthPpq: 1 });
    const second = await addAudioClip({ trackId, assetId: 'stale-b', startPpq: 1, lengthPpq: 1 });
    const pendingIngest = deferred<{ id: string }>();
    const ingest = vi.fn(() => pendingIngest.promise);

    const result = consolidateAudioClips([first, second], { tempoBpm: 60, ingest });
    await flushPromises();
    expect(ingest).toHaveBeenCalledTimes(1);

    moveClip(first, 0.5);
    pendingIngest.resolve({ id: 'stale-consolidated' });

    await expect(result).resolves.toBeNull();
    expect(store.clips.find((clip) => clip.id === first)).toMatchObject({
      assetId: 'stale-a',
      startPpq: 0.5,
    });
    expect(store.clips.find((clip) => clip.id === second)?.assetId).toBe('stale-b');
    expect(store.clips.some((clip) => clip.assetId === 'stale-consolidated')).toBe(false);
  });

  it('does not consolidate into a replacement project with colliding ids and clips', async () => {
    installMockOpfs();
    await saveAsset({ id: 'switch-a', name: 'A', sampleRate: 4 }, [new Float32Array([1, 1])]);
    await saveAsset({ id: 'switch-b', name: 'B', sampleRate: 4 }, [new Float32Array([2, 2])]);
    const trackId = addAudioTrack({ name: 'Audio' });
    const first = await addAudioClip({ trackId, assetId: 'switch-a', startPpq: 0, lengthPpq: 1 });
    const second = await addAudioClip({ trackId, assetId: 'switch-b', startPpq: 1, lengthPpq: 1 });
    const pendingIngest = deferred<{ id: string }>();
    const ingest = vi.fn(() => pendingIngest.promise);

    const result = consolidateAudioClips([first, second], { tempoBpm: 60, ingest });
    await flushPromises();
    expect(ingest).toHaveBeenCalledTimes(1);

    store.dispose();
    await store.init();
    const replacementTrackId = addAudioTrack({ name: 'Audio' });
    const replacementFirst = await addAudioClip({
      trackId: replacementTrackId,
      assetId: 'switch-a',
      startPpq: 0,
      lengthPpq: 1,
    });
    const replacementSecond = await addAudioClip({
      trackId: replacementTrackId,
      assetId: 'switch-b',
      startPpq: 1,
      lengthPpq: 1,
    });
    expect([replacementTrackId, replacementFirst, replacementSecond]).toEqual([
      trackId,
      first,
      second,
    ]);
    const replacementNative = readDoc();

    pendingIngest.resolve({ id: 'old-project-render' });
    await expect(result).resolves.toBeNull();

    expect(readDoc()).toEqual(replacementNative);
    expect(store.clips.map((clip) => clip.assetId)).toContain('switch-a');
    expect(store.clips.map((clip) => clip.assetId)).toContain('switch-b');
    expect(store.clips.some((clip) => clip.assetId === 'old-project-render')).toBe(false);
  });

  it('consolidates looped audio clips by flattening repeats into the baked asset', async () => {
    installMockOpfs();
    await saveAsset({ id: 'loop-source', name: 'Loop', sampleRate: 4 }, [
      new Float32Array([1, 2, 3, 4]),
    ]);
    await saveAsset({ id: 'tail-source', name: 'Tail', sampleRate: 4 }, [new Float32Array([9])]);
    const trackId = addAudioTrack({ name: 'Audio' });
    const loop = await addAudioClip({
      trackId,
      assetId: 'loop-source',
      startPpq: 0,
      lengthPpq: 3,
      loopEnabled: true,
      loopLengthPpq: 1,
      fadeOutPpq: 0.5,
      name: 'Looped',
    });
    const tail = await addAudioClip({
      trackId,
      assetId: 'tail-source',
      startPpq: 3,
      lengthPpq: 0.25,
      name: 'Tail',
    });

    const consolidatedId = await consolidateAudioClips([loop, tail], { tempoBpm: 60 });
    const consolidated = store.clips.find((clip) => clip.id === consolidatedId);
    const baked = await loadAsset(consolidated?.assetId ?? '');

    expect(consolidated).toMatchObject({ startPpq: 0, lengthPpq: 3.25, loopEnabled: false });
    expect(Array.from(baked.channels[0])).toEqual([1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 1.5, 0, 9]);
  });

  it('consolidates take-comp audio clips by baking the selected take segments', async () => {
    installMockOpfs();
    await saveAsset({ id: 'take-a', name: 'Take A', sampleRate: 2 }, [
      new Float32Array([1, 1, 1, 1]),
    ]);
    await saveAsset({ id: 'take-b', name: 'Take B', sampleRate: 2 }, [
      new Float32Array([2, 2, 2, 2]),
    ]);
    await saveAsset({ id: 'tail', name: 'Tail', sampleRate: 2 }, [new Float32Array([9])]);
    const trackId = addAudioTrack({ name: 'Audio' });
    const comped = await addAudioClip({
      trackId,
      assetId: 'take-a',
      startPpq: 0,
      lengthPpq: 2,
      name: 'Comp',
      activeTakeIndex: 0,
      takes: [
        { assetId: 'take-a', name: 'A' },
        { assetId: 'take-b', name: 'B' },
      ],
    });
    setClipCompSegments(comped, [
      { startPpq: 0, takeIndex: 0, crossfadePpq: 0 },
      { startPpq: 1, takeIndex: 1, crossfadePpq: 0 },
    ]);
    const tail = await addAudioClip({
      trackId,
      assetId: 'tail',
      startPpq: 2,
      lengthPpq: 0.5,
      name: 'Tail',
    });

    const consolidatedId = await consolidateAudioClips([comped, tail], { tempoBpm: 60 });
    const consolidated = store.clips.find((clip) => clip.id === consolidatedId);
    const baked = await loadAsset(consolidated?.assetId ?? '');

    expect(consolidated).toMatchObject({ startPpq: 0, lengthPpq: 2.5, sourceOffsetPpq: 0 });
    expect(consolidated?.takes).toBeUndefined();
    expect(consolidated?.compSegments).toBeUndefined();
    expect(Array.from(baked.channels[0])).toEqual([1, 1, 2, 2, 9]);
  });

  it('consolidates warped audio clips by baking the warped window', async () => {
    installMockOpfs();
    await saveAsset({ id: 'warp-source', name: 'Warp', sampleRate: 10 }, [
      new Float32Array(Array.from({ length: 40 }, (_, i) => i)),
    ]);
    await saveAsset({ id: 'warp-tail', name: 'Tail', sampleRate: 10 }, [
      new Float32Array([9, 9, 9, 9, 9]),
    ]);
    const trackId = addAudioTrack({ name: 'Audio' });
    const warped = await addAudioClip({
      trackId,
      assetId: 'warp-source',
      startPpq: 0,
      lengthPpq: 4,
      name: 'Warped',
    });
    setClipWarp(warped, { enabled: true, sourceBpm: 60 });
    const tail = await addAudioClip({
      trackId,
      assetId: 'warp-tail',
      startPpq: 4,
      lengthPpq: 1,
      name: 'Tail',
    });
    const stretch = vi.fn((samples: Float32Array, _sampleRate: number, rate: number) => {
      const frames = Math.max(1, Math.round(samples.length / rate));
      return new Float32Array(
        Array.from({ length: frames }, (_, i) => samples[Math.min(samples.length - 1, i * rate)]),
      );
    });

    const consolidatedId = await consolidateAudioClips([warped, tail], {
      tempoBpm: 120,
      warpStretch: stretch,
    });
    const consolidated = store.clips.find((clip) => clip.id === consolidatedId);
    const baked = await loadAsset(consolidated?.assetId ?? '');

    expect(stretch).toHaveBeenCalledTimes(1);
    expect(consolidated).toMatchObject({ startPpq: 0, lengthPpq: 5, sourceOffsetPpq: 0 });
    expect(consolidated?.warp).toBeUndefined();
    expect(readDoc().warp_maps?.some((map) => map.id === warped)).toBe(false);
    expect(Array.from(baked.channels[0])).toEqual([
      ...Array.from({ length: 20 }, (_, i) => i * 2),
      9,
      9,
      9,
      9,
      9,
    ]);
  });

  it('rejects warped take-comp clips during audio consolidate', async () => {
    installMockOpfs();
    await saveAsset({ id: 'take-warp-a', name: 'Take A', sampleRate: 2 }, [
      new Float32Array([1, 1, 1, 1]),
    ]);
    await saveAsset({ id: 'take-warp-b', name: 'Take B', sampleRate: 2 }, [
      new Float32Array([2, 2, 2, 2]),
    ]);
    const trackId = addAudioTrack({ name: 'Audio' });
    const comped = await addAudioClip({
      trackId,
      assetId: 'take-warp-a',
      startPpq: 0,
      lengthPpq: 2,
      name: 'Comp',
      activeTakeIndex: 0,
      takes: [
        { assetId: 'take-warp-a', name: 'A' },
        { assetId: 'take-warp-b', name: 'B' },
      ],
    });
    const tail = await addAudioClip({
      trackId,
      assetId: 'take-warp-b',
      startPpq: 2,
      lengthPpq: 1,
      name: 'Tail',
    });
    setClipWarp(comped, { enabled: true, sourceBpm: 60 });

    await expect(consolidateAudioClips([comped, tail], { tempoBpm: 120 })).rejects.toThrow(
      /warped take-comp/,
    );
  });

  it('lays down one track and clip per band, in band order, under the source clip', async () => {
    const clipId = await layDownStemSource('Loop');
    const tracksBefore = store.tracks.length;
    const clipsBefore = store.clips.length;

    const stemClipIds = await splitAudioClipToStems(clipId);

    expect(stemClipIds).toHaveLength(3);
    expect(store.tracks).toHaveLength(tracksBefore + 3);
    expect(store.clips).toHaveLength(clipsBefore + 3);
    const stemClips = stemClipIds.map((id) => store.clips.find((clip) => clip.id === id));
    // The band is carried by the name the clip, its track and its asset share.
    expect(stemClips.map((clip) => clip?.name)).toEqual(bandNames('Loop'));
    const stemTracks = stemClips.map((clip) =>
      store.tracks.find((track) => track.id === clip?.trackId),
    );
    expect(stemTracks.map((track) => track?.name)).toEqual(bandNames('Loop'));
    expect(stemTracks.map((track) => track?.kind)).toEqual(['audio', 'audio', 'audio']);
    // Each band gets its own track, its own clip and its own asset.
    expect(new Set(stemTracks.map((track) => track?.id)).size).toBe(3);
    expect(new Set(stemClips.map((clip) => clip?.assetId)).size).toBe(3);
    for (const clip of stemClips) {
      expect(clip).toMatchObject({
        kind: 'audio',
        startPpq: 4,
        lengthPpq: 2,
        sourceOffsetPpq: 0,
        gain: 0.75,
        loopEnabled: false,
        notes: [],
      });
    }
    expect(
      (await listAssets()).map((asset) => asset.name).filter((name) => name.startsWith('Loop ')),
    ).toEqual([...bandNames('Loop')].sort());

    // The native project carries the same placement and one source per band.
    const doc = readDoc();
    expect(doc.tracks.filter((track) => track.name.startsWith('Loop ')).map((t) => t.name)).toEqual(
      bandNames('Loop'),
    );
    const docStemClips = stemClipIds.map((id) => doc.clips.find((clip) => clip.id === id));
    for (const clip of docStemClips) {
      expect(clip).toMatchObject({ start_ppq: 4, length_ppq: 2, gain: 0.75 });
    }
    expect(new Set(docStemClips.map((clip) => clip?.source_id)).size).toBe(3);
  });

  it('leaves imported-stem provenance off the bands it separates itself', async () => {
    const clipId = await layDownStemSource('Loop');

    const stemClipIds = await splitAudioClipToStems(clipId);

    expect(stemClipIds).toHaveLength(3);
    // externalStemRole (src/project/external-stems.ts) records that a clip came
    // from an outside separator, and its vocabulary is deliberately disjoint
    // from the StemKind bands of src/project/audio-stems.ts. A band separated
    // here has no external provenance, so the role stays absent on the clip and
    // on the audio source the Project keeps it in.
    expect(STEM_KINDS.some((kind) => isExternalStemRole(kind))).toBe(false);
    for (const id of stemClipIds) {
      const clip = store.clips.find((entry) => entry.id === id);
      expect(clip?.externalStemRole).toBeUndefined();
      expect(sourceMetadata(id).externalStemRole).toBe('');
    }
    expect(store.clips.filter((clip) => clip.externalStemRole !== undefined)).toEqual([]);
  });

  it('round-trips split stems through a document with the band left in the name', async () => {
    const clipId = await layDownStemSource('Loop');
    const stemClipIds = await splitAudioClipToStems(clipId);
    expect(stemClipIds).toHaveLength(3);

    const doc = serializeProject();
    const stemDocClips = doc.tracks
      .flatMap((track) => track.clips)
      .filter((clip) => clip.name.startsWith('Loop '));
    expect(stemDocClips).toHaveLength(3);
    expect(stemDocClips.map((clip) => clip.name)).toEqual(bandNames('Loop'));
    expect(
      doc.tracks.map((track) => track.name).filter((name) => name.startsWith('Loop ')),
    ).toEqual(bandNames('Loop'));
    // A StemKind is not a persisted field: the document carries no provenance
    // role for these bands, only the names.
    expect(stemDocClips.map((clip) => clip.externalStemRole)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(JSON.stringify(doc)).not.toContain('externalStemRole');

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);

    const reloaded = store.clips.filter((clip) => clip.name.startsWith('Loop '));
    expect(reloaded).toHaveLength(3);
    expect(reloaded.map((clip) => clip.name)).toEqual(bandNames('Loop'));
    expect(
      reloaded.map((clip) => store.tracks.find((track) => track.id === clip.trackId)?.name),
    ).toEqual(bandNames('Loop'));
    expect(reloaded.map((clip) => clip.externalStemRole)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    for (const clip of reloaded) expect(sourceMetadata(clip.id).externalStemRole).toBe('');
    expect(serializeProject()).toEqual(doc);
  });

  it('undoes a stem split as one edit, tracks and clips together', async () => {
    const clipId = await layDownStemSource('Loop');
    clearHistory();
    const tracksBefore = store.tracks.length;
    const clipsBefore = store.clips.length;
    const docTracksBefore = readDoc().tracks.length;
    const docClipsBefore = readDoc().clips.length;
    const sourcesBefore = getProject().sourceCount();

    const stemClipIds = await splitAudioClipToStems(clipId);
    expect(stemClipIds).toHaveLength(3);

    expect(undo()).toBe(true);
    expect(store.tracks).toHaveLength(tracksBefore);
    expect(store.clips).toHaveLength(clipsBefore);
    expect(store.clips.some((clip) => stemClipIds.includes(clip.id))).toBe(false);
    expect(store.tracks.some((track) => track.name.startsWith('Loop '))).toBe(false);
    expect(readDoc().tracks).toHaveLength(docTracksBefore);
    expect(readDoc().clips).toHaveLength(docClipsBefore);
    expect(getProject().sourceCount()).toBe(sourcesBefore);
    expect(undo()).toBe(false);

    expect(redo()).toBe(true);
    expect(
      store.clips.filter((clip) => stemClipIds.includes(clip.id)).map((clip) => clip.name),
    ).toEqual(bandNames('Loop'));
    expect(readDoc().tracks).toHaveLength(docTracksBefore + 3);
    expect(readDoc().clips).toHaveLength(docClipsBefore + 3);
  });

  it('skips stem clip creation when the source clip changes during separation', async () => {
    installMockOpfs();
    await saveAsset({ id: 'stem-source', name: 'Stem Source', sampleRate: 4 }, [
      new Float32Array([1, 2, 3, 4]),
    ]);
    const trackId = addAudioTrack({ name: 'Audio' });
    const clipId = await addAudioClip({
      trackId,
      assetId: 'stem-source',
      startPpq: 0,
      lengthPpq: 1,
      name: 'Loop',
    });
    const initialTrackCount = store.tracks.length;
    const initialClipIds = store.clips.map((clip) => clip.id);
    const hpssWithResidual = vi.fn((samples: Float32Array, sampleRate?: number) => {
      store.clips = store.clips.map((clip) =>
        clip.id === clipId ? { ...clip, assetId: 'stem-replaced' } : clip,
      );
      return {
        harmonic: new Float32Array(samples),
        percussive: new Float32Array(samples),
        residual: new Float32Array(samples),
        sampleRate: sampleRate ?? 4,
      };
    });
    Object.assign(wasmModule.current ?? {}, { hpssWithResidual });

    await expect(splitAudioClipToStems(clipId)).resolves.toEqual([]);

    expect(hpssWithResidual).toHaveBeenCalled();
    expect(store.tracks).toHaveLength(initialTrackCount);
    expect(store.clips.map((clip) => clip.id)).toEqual(initialClipIds);
    expect(store.clips.find((clip) => clip.id === clipId)?.assetId).toBe('stem-replaced');
  });

  it('skips stem placement when the audible tempo context changes during separation', async () => {
    installMockOpfs();
    await saveAsset({ id: 'stem-source', name: 'Stem Source', sampleRate: 4 }, [
      new Float32Array([1, 2, 3, 4]),
    ]);
    const trackId = addAudioTrack({ name: 'Audio' });
    const clipId = await addAudioClip({
      trackId,
      assetId: 'stem-source',
      startPpq: 0,
      lengthPpq: 1,
      name: 'Tempo source',
    });
    const initialTrackCount = store.tracks.length;
    Object.assign(wasmModule.current ?? {}, {
      hpssWithResidual: (samples: Float32Array, sampleRate?: number) => {
        store.tempoBpm = 90;
        return {
          harmonic: samples.slice(),
          percussive: new Float32Array(samples.length),
          residual: new Float32Array(samples.length),
          sampleRate: sampleRate ?? 4,
        };
      },
    });

    await expect(splitAudioClipToStems(clipId)).resolves.toEqual([]);

    expect(store.tracks).toHaveLength(initialTrackCount);
    expect(store.clips.filter((clip) => clip.id !== clipId)).toHaveLength(1);
  });

  it('rolls back earlier stem assets when the second asset sidecar fails', async () => {
    installMockOpfs();
    await saveAsset({ id: 'stem-source', name: 'Stem Source', sampleRate: 4 }, [
      new Float32Array([1, 2, 3, 4]),
    ]);
    const trackId = addAudioTrack({ name: 'Audio' });
    const clipId = await addAudioClip({
      trackId,
      assetId: 'stem-source',
      startPpq: 0,
      lengthPpq: 1,
      name: 'Loop',
    });
    Object.assign(wasmModule.current ?? {}, {
      hpssWithResidual: (samples: Float32Array, sampleRate?: number) => ({
        harmonic: samples.map((value) => value * 2),
        percussive: samples.map((value) => value * 3),
        residual: samples.map((value) => value * 4),
        sampleRate: sampleRate ?? 4,
      }),
    });
    clearHistory();
    const original = MemoryFileHandle.prototype.createWritable;
    let stemSidecars = 0;
    const spy = vi
      .spyOn(MemoryFileHandle.prototype, 'createWritable')
      .mockImplementation(async function () {
        if (this.name.endsWith('.json') && this.name !== 'stem-source.json') {
          stemSidecars += 1;
          if (stemSidecars === 2) {
            return {
              write: async () => {
                throw new Error('second stem sidecar failed');
              },
              close: async () => undefined,
              abort: async () => undefined,
            } as unknown as FileSystemWritableFileStream;
          }
        }
        return original.call(this);
      });

    await expect(splitAudioClipToStems(clipId)).rejects.toThrow('second stem sidecar failed');
    spy.mockRestore();

    expect((await listAssets()).map((asset) => asset.id)).toEqual(['stem-source']);
    expect(store.tracks).toHaveLength(2);
    expect(store.clips).toHaveLength(2);
    expect(undo()).toBe(false);
  });

  it('atomically rolls back stem tracks, clips, and new assets on placement failure', async () => {
    installMockOpfs();
    await saveAsset({ id: 'stem-source', name: 'Stem Source', sampleRate: 4 }, [
      new Float32Array([1, 2, 3, 4]),
    ]);
    const trackId = addAudioTrack({ name: 'Audio' });
    const clipId = await addAudioClip({
      trackId,
      assetId: 'stem-source',
      startPpq: 0,
      lengthPpq: 1,
      name: 'Loop',
    });
    Object.assign(wasmModule.current ?? {}, {
      hpssWithResidual: (samples: Float32Array, sampleRate?: number) => ({
        harmonic: samples.map((value) => value * 2),
        percussive: samples.map((value) => value * 3),
        residual: samples.map((value) => value * 4),
        sampleRate: sampleRate ?? 4,
      }),
    });
    clearHistory();
    const project = getProject();
    const originalAddTrack = project.addTrack.bind(project);
    let stemTrackCalls = 0;
    const spy = vi.spyOn(project, 'addTrack').mockImplementation((descriptor) => {
      stemTrackCalls += 1;
      if (stemTrackCalls === 2) throw new Error('second stem placement failed');
      return originalAddTrack(descriptor);
    });

    await expect(splitAudioClipToStems(clipId)).rejects.toThrow('second stem placement failed');
    spy.mockRestore();

    expect((await listAssets()).map((asset) => asset.id)).toEqual(['stem-source']);
    expect(store.tracks).toHaveLength(2);
    expect(store.clips).toHaveLength(2);
    expect(readDoc().tracks).toHaveLength(2);
    expect(readDoc().clips).toHaveLength(2);
    expect(undo()).toBe(false);
  });

  it('swaps a clip asset as one undoable command while preserving clip metadata', async () => {
    installMockOpfs();
    await saveAsset({ id: 'swap-a', name: 'A', sampleRate: 4 }, [new Float32Array([1, 2, 3, 4])]);
    await saveAsset({ id: 'swap-b', name: 'B', sampleRate: 4 }, [new Float32Array([5, 6, 7, 8])]);
    const trackId = addAudioTrack({ name: 'Audio' });
    const oldClipId = await addAudioClip({
      trackId,
      assetId: 'swap-a',
      startPpq: 3,
      lengthPpq: 4,
      sourceOffsetPpq: 1,
      gain: 0.75,
      name: 'Keep me',
      fadeInPpq: 0.5,
      fadeOutPpq: 1,
      loopEnabled: true,
      loopLengthPpq: 2,
      warp: { enabled: true, sourceBpm: 100, anchors: [{ ppq: 2, sourceSeconds: 1 }] },
    });
    clearHistory();

    const newClipId = replaceAudioClipAsset(oldClipId, 'swap-b');
    expect(newClipId).not.toBe(oldClipId);
    expect(store.clips.find((clip) => clip.id === newClipId)).toMatchObject({
      assetId: 'swap-b',
      name: 'Keep me',
      startPpq: 3,
      lengthPpq: 4,
      sourceOffsetPpq: 1,
      gain: 0.75,
      fadeInPpq: 0.5,
      fadeOutPpq: 1,
      loopEnabled: true,
      loopLengthPpq: 2,
      warp: { enabled: true, sourceBpm: 100, anchors: [{ ppq: 2, sourceSeconds: 1 }] },
    });
    expect(store.clips.some((clip) => clip.id === oldClipId)).toBe(false);
    expect(readDoc().warp_maps?.map((map) => map.id)).toEqual([newClipId]);

    expect(undo()).toBe(true);
    expect(store.clips.find((clip) => clip.id === oldClipId)?.assetId).toBe('swap-a');
    expect(store.clips.some((clip) => clip.id === newClipId)).toBe(false);
    expect(readDoc().warp_maps?.map((map) => map.id)).toEqual([oldClipId]);
    expect(undo()).toBe(false);
    expect(redo()).toBe(true);
    expect(store.clips.find((clip) => clip.id === newClipId)?.assetId).toBe('swap-b');
    expect(readDoc().warp_maps?.map((map) => map.id)).toEqual([newClipId]);
  });

  it('keeps the original clip when the final asset-swap removal fails', async () => {
    installMockOpfs();
    await saveAsset({ id: 'swap-a', name: 'A', sampleRate: 4 }, [new Float32Array([1, 2])]);
    await saveAsset({ id: 'swap-b', name: 'B', sampleRate: 4 }, [new Float32Array([3, 4])]);
    const trackId = addAudioTrack({ name: 'Audio' });
    const clipId = await addAudioClip({
      trackId,
      assetId: 'swap-a',
      startPpq: 2,
      lengthPpq: 1,
      name: 'Original',
    });
    clearHistory();
    const project = getProject();
    const spy = vi.spyOn(project, 'removeClip').mockImplementation(() => {
      throw new Error('remove failed');
    });

    expect(() => replaceAudioClipAsset(clipId, 'swap-b')).toThrow('remove failed');
    spy.mockRestore();

    expect(store.clips.filter((clip) => clip.trackId === trackId)).toEqual([
      expect.objectContaining({ id: clipId, assetId: 'swap-a', name: 'Original' }),
    ]);
    expect(readDoc().clips.filter((clip) => clip.track_id === trackId)).toHaveLength(1);
    expect(undo()).toBe(false);
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
    await expect(
      addAudioClip({ trackId, assetId: 'a', lengthPpq: 1, fadeInPpq: 0.75, fadeOutPpq: 0.5 }),
    ).rejects.toThrow(/must not exceed clip length/);
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
    expect(() => setClipFades(clipId, 7, 2)).toThrow(/must not exceed clip length/);
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
    let doc = readDoc();
    expect(doc.clips.find((c) => c.id === clipId)).toMatchObject({
      warp_ref_id: clipId,
      warp_mode: 2,
    });
    expect(doc.warp_maps).toEqual([
      {
        id: clipId,
        name: `clip-${clipId}-warp`,
        anchors: [
          { warpSample: 0, sourceSample: 0 },
          { warpSample: 48000, sourceSample: 48000 },
          { warpSample: 144000, sourceSample: 144000 },
          { warpSample: 192000, sourceSample: 242526 },
        ],
      },
    ]);

    undo();
    expect(store.clips.find((c) => c.id === clipId)?.warp).toBeUndefined();
    doc = readDoc();
    expect(doc.clips.find((c) => c.id === clipId)?.warp_ref_id).toBeUndefined();
    expect(doc.clips.find((c) => c.id === clipId)?.warp_mode).toBeUndefined();
    expect(doc.warp_maps).toEqual([]);
    redo();
    expect(store.clips.find((c) => c.id === clipId)?.warp).toMatchObject({
      enabled: true,
      sourceBpm: 95,
    });
    expect(readDoc().clips.find((c) => c.id === clipId)).toMatchObject({
      warp_ref_id: clipId,
      warp_mode: 2,
    });

    // null clears the warp state, undoably too.
    setClipWarp(clipId, null);
    expect(store.clips.find((c) => c.id === clipId)?.warp).toBeUndefined();
    expect(readDoc().warp_maps).toEqual([]);
    undo();
    expect(store.clips.find((c) => c.id === clipId)?.warp).toMatchObject({ sourceBpm: 95 });
    expect(readDoc().clips.find((c) => c.id === clipId)).toMatchObject({
      warp_ref_id: clipId,
      warp_mode: 2,
    });
  });

  it('duplicate, split and trim preserve warp metadata in the derived window', async () => {
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({ trackId, assetId: 'asset-x', lengthPpq: 8 });
    setClipWarp(clipId, {
      enabled: true,
      sourceBpm: 120,
      anchors: [
        { ppq: 2, sourceSeconds: 1 },
        { ppq: 6, sourceSeconds: 3 },
      ],
    });

    const copyId = duplicateClip(clipId, 16);
    expect(store.clips.find((c) => c.id === copyId)?.warp).toEqual({
      enabled: true,
      sourceBpm: 120,
      anchors: [
        { ppq: 2, sourceSeconds: 1 },
        { ppq: 6, sourceSeconds: 3 },
      ],
    });
    expect(readDoc().clips.find((clip) => clip.id === copyId)).toMatchObject({
      warp_ref_id: copyId,
      warp_mode: 2,
    });
    expect(
      readDoc()
        .warp_maps?.map((map) => map.id)
        .sort((a, b) => a - b),
    ).toEqual([clipId, copyId].sort((a, b) => a - b));

    const rightId = splitClip(clipId, 4);
    expect(store.clips.find((c) => c.id === clipId)?.warp).toEqual({
      enabled: true,
      sourceBpm: 120,
      anchors: [{ ppq: 2, sourceSeconds: 1 }],
    });
    expect(store.clips.find((c) => c.id === rightId)?.warp).toEqual({
      enabled: true,
      sourceBpm: 120,
      anchors: [{ ppq: 2, sourceSeconds: 1 }],
    });
    expect(readDoc().clips.find((clip) => clip.id === rightId)).toMatchObject({
      warp_ref_id: rightId,
      warp_mode: 2,
    });
    expect(readDoc().warp_maps?.some((map) => map.id === rightId)).toBe(true);

    trimClip(copyId, 17, 5);
    expect(store.clips.find((c) => c.id === copyId)?.warp).toEqual({
      enabled: true,
      sourceBpm: 120,
      anchors: [{ ppq: 1, sourceSeconds: 0.5 }],
    });
    expect(readDoc().clips.find((clip) => clip.id === copyId)?.warp_ref_id).toBe(copyId);
    expect(readDoc().warp_maps?.find((map) => map.id === copyId)?.anchors).toHaveLength(3);
  });

  it('keeps curved warp source times continuous across split and trim boundaries', async () => {
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({ trackId, assetId: 'asset-x', lengthPpq: 8 });
    setClipWarp(clipId, {
      enabled: true,
      sourceBpm: 120,
      anchors: [
        { ppq: 2, sourceSeconds: 0.5 },
        { ppq: 6, sourceSeconds: 3.2 },
      ],
    });
    const sourceClip = store.clips.find((clip) => clip.id === clipId)!;
    const source = {
      sourceOffsetPpq: sourceClip.sourceOffsetPpq,
      lengthPpq: sourceClip.lengthPpq,
      warp: {
        ...sourceClip.warp!,
        ...(sourceClip.warp?.anchors
          ? { anchors: sourceClip.warp.anchors.map((anchor) => ({ ...anchor })) }
          : {}),
      },
    };
    const rightId = splitClip(clipId, 4);
    const right = store.clips.find((clip) => clip.id === rightId)!;
    const left = store.clips.find((clip) => clip.id === clipId)!;

    // The midpoint lies on a curved segment: its source time is 1.85 s,
    // not the linear source-offset value of 2 s that Project.trimClip uses.
    expect(right.warp?.sourceStartSeconds).toBeCloseTo(1.85, 8);
    expect(left.warp?.sourceEndSeconds).toBeCloseTo(1.85, 8);
    for (const ppq of [0, 1, 2, 4]) {
      expect(warpSourceSecondsAt(right, ppq)).toBeCloseTo(warpSourceSecondsAt(source, ppq + 4)!, 8);
    }
    for (const ppq of [0, 1, 2, 4]) {
      expect(warpSourceSecondsAt(left, ppq)).toBeCloseTo(warpSourceSecondsAt(source, ppq)!, 8);
    }

    trimClip(rightId, 5, 2);
    const trimmed = store.clips.find((clip) => clip.id === rightId)!;
    for (const ppq of [0, 1, 2]) {
      expect(warpSourceSecondsAt(trimmed, ppq)).toBeCloseTo(
        warpSourceSecondsAt(source, ppq + 5)!,
        8,
      );
    }
  });

  it('clears warp failure-atomically and skips a missing map', async () => {
    const trackId = addAudioTrack();
    const plainClipId = await addAudioClip({ trackId, assetId: 'asset-x', lengthPpq: 8 });
    clearHistory();
    const plainProject = getProject();
    const missingRemove = vi.spyOn(plainProject, 'removeWarpMap');
    setClipWarp(plainClipId, null);
    expect(missingRemove).not.toHaveBeenCalled();
    expect(undo()).toBe(false);
    missingRemove.mockRestore();

    setClipWarp(plainClipId, { enabled: true, sourceBpm: 100 });
    clearHistory();
    const nativeBefore = plainProject.toJson();
    const mirrorBefore = JSON.stringify(store.clips);
    const remove = vi.spyOn(plainProject, 'removeWarpMap').mockImplementationOnce(() => {
      throw new Error('injected remove failure');
    });

    expect(() => setClipWarp(plainClipId, null)).toThrow('injected remove failure');
    expect(plainProject.toJson()).toBe(nativeBefore);
    expect(JSON.stringify(store.clips)).toBe(mirrorBefore);
    expect(undo()).toBe(false);
    remove.mockRestore();
  });

  it('rolls back a warped clip creation when native warp binding fails', async () => {
    const trackId = addAudioTrack();
    clearHistory();
    const project = getProject();
    const nativeBefore = project.toJson();
    const mirrorBefore = JSON.stringify(store.clips);
    const bind = vi.spyOn(project, 'setClipWarpRef').mockImplementationOnce(() => {
      throw new Error('injected warp bind failure');
    });

    await expect(
      addAudioClip({
        trackId,
        assetId: 'asset-warp-failure',
        lengthPpq: 8,
        warp: { enabled: true, sourceBpm: 100 },
      }),
    ).rejects.toThrow('injected warp bind failure');
    expect(project.toJson()).toBe(nativeBefore);
    expect(JSON.stringify(store.clips)).toBe(mirrorBefore);
    expect(undo()).toBe(false);
    bind.mockRestore();
  });

  it('deletes and restores a clip-owned native warp map with its clip', async () => {
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({
      trackId,
      assetId: 'asset-warp-delete',
      lengthPpq: 8,
      warp: { enabled: true, sourceBpm: 100 },
    });
    clearHistory();

    deleteClip(clipId);
    expect(readDoc().warp_maps?.some((map) => map.id === clipId)).toBe(false);
    expect(undo()).toBe(true);
    expect(readDoc().clips.find((clip) => clip.id === clipId)?.warp_ref_id).toBe(clipId);
    expect(readDoc().warp_maps?.some((map) => map.id === clipId)).toBe(true);
    expect(redo()).toBe(true);
    expect(readDoc().warp_maps?.some((map) => map.id === clipId)).toBe(false);
  });

  it('rehydrates native warp sample anchors when the tempo map changes', async () => {
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({
      trackId,
      assetId: 'asset-warp-tempo',
      lengthPpq: 8,
      warp: { enabled: true, sourceBpm: 100 },
    });
    const before = readDoc().warp_maps?.find((map) => map.id === clipId)?.anchors;
    clearHistory();

    setTempoSegments([{ startPpq: 0, bpm: 60 }]);
    const after = readDoc().warp_maps?.find((map) => map.id === clipId)?.anchors;
    expect(after?.at(-1)?.warpSample).toBe((before?.at(-1)?.warpSample ?? 0) * 2);
    expect(undo()).toBe(true);
    expect(readDoc().warp_maps?.find((map) => map.id === clipId)?.anchors).toEqual(before);
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

  it('moveClip rejects an audio clip on MIDI and routing tracks', async () => {
    const audioTrackId = addAudioTrack();
    const clipId = await addAudioClip({ trackId: audioTrackId, assetId: 'asset-x', lengthPpq: 8 });
    const midiTrackId = store.tracks.find((track) => track.kind === 'midi')?.id as number;
    const auxTrackId = addTrack({ name: 'Return', kind: 'aux' });
    const groupTrackId = addTrack({ name: 'Group', kind: 'group' });
    clearHistory();

    expect(() => moveClip(clipId, 4, midiTrackId)).toThrow(/Cannot move audio clip/);
    expect(() => moveClip(clipId, 4, auxTrackId)).toThrow(/Cannot move audio clip/);
    expect(() => moveClip(clipId, 4, groupTrackId)).toThrow(/Cannot move audio clip/);
    expect(store.clips.find((clip) => clip.id === clipId)).toMatchObject({
      trackId: audioTrackId,
      startPpq: 0,
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

  it('rejects partial-repeat loop audio clips without changing native or mirror state', async () => {
    const trackId = addAudioTrack();
    const clipId = await addAudioClip({ trackId, assetId: 'asset-x', lengthPpq: 8 });
    setClipLoop(clipId, true, 3);
    clearHistory();
    const nativeBefore = getProject().toJson();
    const mirrorBefore = JSON.stringify(store.clips);

    expect(() => splitClip(clipId, 4)).toThrow(/Turn Loop off/);
    expect(getProject().toJson()).toBe(nativeBefore);
    expect(JSON.stringify(store.clips)).toBe(mirrorBefore);
  });
});
