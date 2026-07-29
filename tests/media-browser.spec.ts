import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MediaBrowser from '@/components/media/MediaBrowser.vue';
import { clearAudioAssetLeases } from '@/persistence/asset-leases';
import type { AudioAssetMeta, LoadedAudioAsset } from '@/persistence/assets';
import { useProjectStore } from '@/project/store';
import type { EditorClip, EditorTrack } from '@/project/types';
import { ASSET_DRAG_MIME } from '@/ui/media/asset-drag';
import { asAudioContext, createFakeAudioContext } from './fake-audio-context';
import { readOptionLabels, selectOption } from './helpers/select-menu';

const assetStore = vi.hoisted(() => {
  const deleteAsset = vi.fn<(id: string) => Promise<void>>();
  return {
    listAssets: vi.fn<() => Promise<AudioAssetMeta[]>>(),
    loadAsset: vi.fn<(id: string) => Promise<LoadedAudioAsset>>(),
    deleteAsset,
    deleteAssetUnlocked: deleteAsset,
  };
});
vi.mock('@/persistence/assets', () => assetStore);

const decodeAndIngestMock = vi.hoisted(() => vi.fn());
vi.mock('@/project/audio-import', () => ({ decodeAndIngest: decodeAndIngestMock }));

const historyRefs = vi.hoisted(() => ({ assetIds: new Set<string>() }));
vi.mock('@/project/commands', () => ({
  collectHistoryReferencedMediaIds: () => ({ assetIds: historyRefs.assetIds, fontIds: new Set() }),
}));

/** Module returned by the mocked ensureWasm; tests add timeStretch here. */
const wasmModule = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@/lib/wasm', () => ({ ensureWasm: vi.fn(async () => wasmModule.current) }));

/** Builds asset metadata with sensible defaults. */
function meta(overrides: Partial<AudioAssetMeta> = {}): AudioAssetMeta {
  return {
    id: 'asset-1',
    name: 'Loop',
    sampleRate: 48000,
    numChannels: 2,
    numFrames: 48000,
    ...overrides,
  };
}

/** Builds a loaded asset whose channels match the metadata. */
function loaded(metaOverrides: Partial<AudioAssetMeta> = {}): LoadedAudioAsset {
  const m = meta(metaOverrides);
  return {
    meta: m,
    channels: Array.from({ length: m.numChannels }, () => new Float32Array(m.numFrames)),
  };
}

/** Creates a manually-resolved promise for async race tests. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A minimal audio clip mirror referencing an asset. */
function audioClip(assetId: string): EditorClip {
  return {
    id: 1,
    trackId: 1,
    name: 'Audio clip',
    startPpq: 0,
    lengthPpq: 4,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [],
    kind: 'audio',
    assetId,
  };
}

/** A minimal track mirror for reference-guard tests. */
function track(overrides: Partial<EditorTrack> = {}): EditorTrack {
  return {
    id: 1,
    name: 'Audio',
    color: '#60a5fa',
    kind: 'audio',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: 0,
    ...overrides,
  };
}

async function mountBrowser(props: Record<string, unknown> = {}): Promise<VueWrapper> {
  const wrapper = mount(MediaBrowser, { props });
  await flushPromises();
  return wrapper;
}

function rowNames(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.asset-name').map((n) => n.text());
}

function rowButton(wrapper: VueWrapper, name: string, selector: string) {
  const row = wrapper.findAll('.asset-row').find((r) => r.find('.asset-name').text() === name);
  if (!row) throw new Error(`Row "${name}" not found`);
  return row.find(selector);
}

describe('MediaBrowser', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    clearAudioAssetLeases();
    historyRefs.assetIds.clear();
    wasmModule.current = {};
    assetStore.listAssets.mockResolvedValue([]);
    assetStore.deleteAsset.mockResolvedValue();
  });

  it('lists assets with formatted metadata after mount', async () => {
    assetStore.listAssets.mockResolvedValue([
      meta({
        id: 'a',
        name: 'Drum Loop',
        tags: {
          bpm: 120,
          key: 'Am',
          timeSignature: '7/8',
          grooveType: 'breakbeat',
          dynamicRangeDb: 8.25,
          brightness: 0.61,
        },
      }),
      meta({ id: 'b', name: 'Bass', numChannels: 1, numFrames: 96000, sampleRate: 44100 }),
    ]);
    const wrapper = await mountBrowser();
    expect(rowNames(wrapper)).toEqual(['Bass', 'Drum Loop']);
    const summaries = wrapper.findAll('.asset-summary').map((s) => s.text());
    expect(summaries[1]).toBe(
      '0:01.0 · stereo · 48 kHz · 120 BPM · Am · 7/8 · breakbeat · DR 8.3 dB · Bright 0.61',
    );
    expect(summaries[0]).toBe('0:02.2 · mono · 44.1 kHz');
  });

  it('refreshes the asset list when the panel becomes visible again', async () => {
    assetStore.listAssets
      .mockResolvedValueOnce([meta({ id: 'a', name: 'Before' })])
      .mockResolvedValueOnce([meta({ id: 'b', name: 'After' })]);

    const wrapper = await mountBrowser({ visible: false });
    expect(rowNames(wrapper)).toEqual(['Before']);

    await wrapper.setProps({ visible: true });
    await flushPromises();

    expect(assetStore.listAssets).toHaveBeenCalledTimes(2);
    expect(rowNames(wrapper)).toEqual(['After']);
  });

  it('shows the empty state and the list error', async () => {
    const empty = await mountBrowser();
    expect(empty.find('.empty-state').text()).toContain('No audio assets');

    assetStore.listAssets.mockRejectedValue(new Error('OPFS is unavailable'));
    const failed = await mountBrowser();
    expect(failed.find('.error').text()).toBe('OPFS is unavailable');
  });

  it('filters by name text', async () => {
    assetStore.listAssets.mockResolvedValue([
      meta({ id: 'a', name: 'Drum Loop' }),
      meta({ id: 'b', name: 'Bass' }),
    ]);
    const wrapper = await mountBrowser();
    await wrapper.find('.filter-text input').setValue('drum');
    expect(rowNames(wrapper)).toEqual(['Drum Loop']);
    await wrapper.find('.filter-text input').setValue('zzz');
    expect(wrapper.find('.empty-state').text()).toBe('No assets match the filters.');
  });

  it('offers the key tags as dropdown options and filters by them', async () => {
    assetStore.listAssets.mockResolvedValue([
      meta({ id: 'a', name: 'A', tags: { key: 'Cm' } }),
      meta({ id: 'b', name: 'B', tags: { key: 'Am' } }),
      meta({ id: 'c', name: 'C' }),
    ]);
    const wrapper = await mountBrowser();
    expect(await readOptionLabels(wrapper, '.filter-key')).toEqual(['Any key', 'Am', 'Cm']);
    await selectOption(wrapper, '.filter-key', 'Am');
    expect(rowNames(wrapper)).toEqual(['B']);
  });

  it('filters by BPM range and flags invalid input', async () => {
    assetStore.listAssets.mockResolvedValue([
      meta({ id: 'a', name: 'A', tags: { bpm: 90 } }),
      meta({ id: 'b', name: 'B', tags: { bpm: 140 } }),
      meta({ id: 'c', name: 'C' }),
    ]);
    const wrapper = await mountBrowser();
    await wrapper.find('.filter-bpm').setValue('100-150');
    expect(rowNames(wrapper)).toEqual(['B']);
    expect(wrapper.find('.filter-bpm').classes()).not.toContain('invalid');
    await wrapper.find('.filter-bpm').setValue('fast');
    expect(wrapper.find('.filter-bpm').classes()).toContain('invalid');
    expect(rowNames(wrapper)).toEqual(['A', 'B', 'C']);
  });

  it('sorts by duration and BPM', async () => {
    assetStore.listAssets.mockResolvedValue([
      meta({ id: 'a', name: 'A', numFrames: 96000, tags: { bpm: 150 } }),
      meta({ id: 'b', name: 'B', numFrames: 24000, tags: { bpm: 90 } }),
      meta({ id: 'c', name: 'C', numFrames: 48000 }),
    ]);
    const wrapper = await mountBrowser();
    await selectOption(wrapper, '.sort-key', 'Duration');
    expect(rowNames(wrapper)).toEqual(['B', 'C', 'A']);
    await selectOption(wrapper, '.sort-key', 'BPM');
    expect(rowNames(wrapper)).toEqual(['B', 'A', 'C']);
  });

  it('imports picked files and reports per-file errors', async () => {
    const wrapper = await mountBrowser();
    decodeAndIngestMock
      .mockResolvedValueOnce(meta({ id: 'ok' }))
      .mockRejectedValueOnce(new Error('Unsupported codec'));
    assetStore.listAssets.mockResolvedValue([meta({ id: 'ok', name: 'good' })]);

    const good = new File([new Uint8Array(4)], 'good.wav', { type: 'audio/wav' });
    const bad = new File([new Uint8Array(4)], 'bad.xyz', { type: 'audio/xyz' });
    const input = wrapper.find('.file-input');
    Object.defineProperty(input.element, 'files', { value: [good, bad], configurable: true });
    await input.trigger('change');
    await flushPromises();

    expect(decodeAndIngestMock).toHaveBeenCalledTimes(2);
    expect(decodeAndIngestMock).toHaveBeenCalledWith(good);
    const errors = wrapper.find('.import-errors');
    expect(errors.text()).toContain('bad.xyz');
    expect(errors.text()).toContain('Unsupported codec');
    // The list refreshed after the import batch.
    expect(rowNames(wrapper)).toEqual(['good']);
    expect(wrapper.find('.import-progress').exists()).toBe(false);
  });

  it('imports files dropped onto the panel', async () => {
    const wrapper = await mountBrowser();
    decodeAndIngestMock.mockResolvedValue(meta());
    const file = new File([new Uint8Array(4)], 'drop.wav', { type: 'audio/wav' });
    await wrapper.trigger('drop', { dataTransfer: { types: ['Files'], files: [file] } });
    await flushPromises();
    expect(decodeAndIngestMock).toHaveBeenCalledWith(file);
    expect(assetStore.listAssets).toHaveBeenCalledTimes(2);
  });

  it('ignores drops that carry no files', async () => {
    const wrapper = await mountBrowser();
    await wrapper.trigger('drop', {
      dataTransfer: { types: [ASSET_DRAG_MIME], files: [], getData: () => 'x' },
    });
    await flushPromises();
    expect(decodeAndIngestMock).not.toHaveBeenCalled();
  });

  it('emits add-to-project with the asset id', async () => {
    assetStore.listAssets.mockResolvedValue([meta({ id: 'a1', name: 'Loop' })]);
    const wrapper = await mountBrowser();
    await rowButton(wrapper, 'Loop', '.add-button').trigger('click');
    expect(wrapper.emitted('add-to-project')).toEqual([['a1']]);
  });

  it('sets the asset drag payload on row dragstart', async () => {
    assetStore.listAssets.mockResolvedValue([meta({ id: 'a1', name: 'Loop' })]);
    const wrapper = await mountBrowser();
    const setData = vi.fn();
    await wrapper
      .find('.asset-row')
      .trigger('dragstart', { dataTransfer: { setData, effectAllowed: 'none' } });
    expect(setData).toHaveBeenCalledWith(ASSET_DRAG_MIME, 'a1');
    expect(setData).toHaveBeenCalledWith('text/plain', 'a1');
  });

  it('deletes an asset after inline confirmation', async () => {
    assetStore.listAssets.mockResolvedValue([meta({ id: 'a1', name: 'Loop' })]);
    const wrapper = await mountBrowser();
    await rowButton(wrapper, 'Loop', '.delete-button').trigger('click');
    expect(assetStore.deleteAsset).not.toHaveBeenCalled();
    assetStore.listAssets.mockResolvedValue([]);
    await rowButton(wrapper, 'Loop', '.danger').trigger('click');
    await vi.waitFor(() => expect(assetStore.deleteAsset).toHaveBeenCalledWith('a1'));
    expect(wrapper.find('.empty-state').exists()).toBe(true);
  });

  it('cancel keeps the asset', async () => {
    assetStore.listAssets.mockResolvedValue([meta({ id: 'a1', name: 'Loop' })]);
    const wrapper = await mountBrowser();
    await rowButton(wrapper, 'Loop', '.delete-button').trigger('click');
    const cancel = wrapper.findAll('button').find((b) => b.text() === 'Cancel');
    await cancel?.trigger('click');
    expect(assetStore.deleteAsset).not.toHaveBeenCalled();
    expect(wrapper.find('.delete-button').exists()).toBe(true);
  });

  it('blocks deleting assets referenced by project clips', async () => {
    assetStore.listAssets.mockResolvedValue([meta({ id: 'a1', name: 'Loop' })]);
    const store = useProjectStore();
    store.clips = [audioClip('a1')];
    const wrapper = await mountBrowser();
    const button = rowButton(wrapper, 'Loop', '.delete-button');
    expect(button.attributes('disabled')).toBeDefined();
    await button.trigger('click');
    expect(wrapper.find('.danger').exists()).toBe(false);
    expect(assetStore.deleteAsset).not.toHaveBeenCalled();
  });

  it('blocks deleting assets referenced only by inactive comp takes', async () => {
    assetStore.listAssets.mockResolvedValue([meta({ id: 'take-a', name: 'Take A' })]);
    const store = useProjectStore();
    const clip = audioClip('active-a');
    clip.takes = [
      { assetId: 'active-a', name: 'Take 1' },
      { assetId: 'take-a', name: 'Take 2' },
    ];
    store.clips = [clip];

    const wrapper = await mountBrowser();
    const button = rowButton(wrapper, 'Take A', '.delete-button');

    expect(button.attributes('disabled')).toBeDefined();
    await button.trigger('click');
    expect(wrapper.find('.danger').exists()).toBe(false);
    expect(assetStore.deleteAsset).not.toHaveBeenCalled();
  });

  it('blocks deleting an asset retained only by undo or redo history', async () => {
    assetStore.listAssets.mockResolvedValue([meta({ id: 'undo-a', name: 'Undo take' })]);
    historyRefs.assetIds.add('undo-a');

    const wrapper = await mountBrowser();
    const button = rowButton(wrapper, 'Undo take', '.delete-button');

    expect(button.attributes('disabled')).toBeDefined();
    await button.trigger('click');
    expect(wrapper.find('.danger').exists()).toBe(false);
    expect(assetStore.deleteAsset).not.toHaveBeenCalled();
  });

  it('blocks deleting assets referenced only by frozen tracks', async () => {
    assetStore.listAssets.mockResolvedValue([meta({ id: 'frozen-a', name: 'Frozen A' })]);
    const store = useProjectStore();
    store.tracks = [track({ frozen: { assetId: 'frozen-a' } })];

    const wrapper = await mountBrowser();
    const button = rowButton(wrapper, 'Frozen A', '.delete-button');

    expect(button.attributes('disabled')).toBeDefined();
    await button.trigger('click');
    expect(wrapper.find('.danger').exists()).toBe(false);
    expect(assetStore.deleteAsset).not.toHaveBeenCalled();
  });

  it('previews an asset through the injected context factory, lazily', async () => {
    assetStore.listAssets.mockResolvedValue([meta({ id: 'a1', name: 'Loop' })]);
    assetStore.loadAsset.mockResolvedValue(loaded({ id: 'a1', name: 'Loop' }));
    const context = createFakeAudioContext();
    const factory = vi.fn(() => asAudioContext(context));
    const wrapper = await mountBrowser({ previewContextFactory: factory });
    expect(factory).not.toHaveBeenCalled();

    const play = rowButton(wrapper, 'Loop', '.preview-button');
    await play.trigger('click');
    await flushPromises();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(context.sources[0].started).toBe(true);
    expect(play.classes()).toContain('playing');

    await play.trigger('click');
    await flushPromises();
    expect(context.sources[0].stopped).toBe(true);
    expect(play.classes()).not.toContain('playing');
  });

  it('ignores a stale preview load when a newer asset is requested first', async () => {
    assetStore.listAssets.mockResolvedValue([
      meta({ id: 'a1', name: 'Loop A' }),
      meta({ id: 'a2', name: 'Loop B' }),
    ]);
    const first = deferred<LoadedAudioAsset>();
    const second = deferred<LoadedAudioAsset>();
    assetStore.loadAsset.mockImplementation((id) => (id === 'a1' ? first.promise : second.promise));
    const context = createFakeAudioContext();
    const wrapper = await mountBrowser({
      previewContextFactory: () => asAudioContext(context),
    });

    await rowButton(wrapper, 'Loop A', '.preview-button').trigger('click');
    await rowButton(wrapper, 'Loop B', '.preview-button').trigger('click');
    second.resolve(loaded({ id: 'a2', name: 'Loop B' }));
    await flushPromises();
    first.resolve(loaded({ id: 'a1', name: 'Loop A' }));
    await flushPromises();

    expect(context.sources).toHaveLength(1);
    expect(context.sources[0].started).toBe(true);
    expect(rowButton(wrapper, 'Loop B', '.preview-button').classes()).toContain('playing');
    expect(rowButton(wrapper, 'Loop A', '.preview-button').classes()).not.toContain('playing');
  });

  it('does not start preview playback after the browser unmounts', async () => {
    assetStore.listAssets.mockResolvedValue([meta({ id: 'a1', name: 'Loop' })]);
    const pending = deferred<LoadedAudioAsset>();
    assetStore.loadAsset.mockReturnValue(pending.promise);
    const context = createFakeAudioContext();
    const wrapper = await mountBrowser({
      previewContextFactory: () => asAudioContext(context),
    });

    await rowButton(wrapper, 'Loop', '.preview-button').trigger('click');
    wrapper.unmount();
    pending.resolve(loaded({ id: 'a1', name: 'Loop' }));
    await flushPromises();

    expect(context.sources).toHaveLength(0);
  });

  it('shows a preview error when the asset cannot be loaded', async () => {
    assetStore.listAssets.mockResolvedValue([meta({ id: 'a1', name: 'Loop' })]);
    assetStore.loadAsset.mockRejectedValue(new Error('PCM payload missing'));
    const wrapper = await mountBrowser({
      previewContextFactory: () => asAudioContext(createFakeAudioContext()),
    });
    await rowButton(wrapper, 'Loop', '.preview-button').trigger('click');
    await flushPromises();
    expect(wrapper.find('.error').text()).toBe('PCM payload missing');
  });

  it('hides the tempo-sync toggle when the module lacks timeStretch', async () => {
    const wrapper = await mountBrowser();
    expect(wrapper.find('.sync-toggle').exists()).toBe(false);
  });

  it('stretches the preview to the project tempo when sync is enabled', async () => {
    const timeStretch = vi.fn(
      (samples: Float32Array, _sr: number, rate: number) =>
        new Float32Array(Math.round(samples.length / rate)),
    );
    wasmModule.current = { timeStretch };
    assetStore.listAssets.mockResolvedValue([meta({ id: 'a1', name: 'Loop', tags: { bpm: 120 } })]);
    assetStore.loadAsset.mockResolvedValue(loaded({ id: 'a1', name: 'Loop' }));
    const context = createFakeAudioContext();
    const store = useProjectStore();
    store.tempoBpm = 60;
    const wrapper = await mountBrowser({
      previewContextFactory: () => asAudioContext(context),
    });

    const toggle = wrapper.find('.sync-toggle');
    expect(toggle.exists()).toBe(true);
    expect(toggle.attributes('aria-pressed')).toBe('false');
    await toggle.trigger('click');
    expect(toggle.attributes('aria-pressed')).toBe('true');
    await rowButton(wrapper, 'Loop', '.preview-button').trigger('click');
    await flushPromises();
    // Rate 0.5 (60 / 120) doubles the buffer length.
    expect(timeStretch).toHaveBeenCalledTimes(2);
    expect(timeStretch.mock.calls[0][2]).toBe(0.5);
    expect(context.sources[0].buffer?.length).toBe(96000);
  });

  it('plays unstretched when the tempos already match', async () => {
    const timeStretch = vi.fn();
    wasmModule.current = { timeStretch };
    assetStore.listAssets.mockResolvedValue([meta({ id: 'a1', name: 'Loop', tags: { bpm: 120 } })]);
    assetStore.loadAsset.mockResolvedValue(loaded({ id: 'a1', name: 'Loop' }));
    const context = createFakeAudioContext();
    const wrapper = await mountBrowser({
      previewContextFactory: () => asAudioContext(context),
    });
    await wrapper.find('.sync-toggle').trigger('click');
    await rowButton(wrapper, 'Loop', '.preview-button').trigger('click');
    await flushPromises();
    expect(timeStretch).not.toHaveBeenCalled();
    expect(context.sources[0].buffer?.length).toBe(48000);
  });
});
