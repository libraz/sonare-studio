import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssetNotFoundError,
  audioAssetCacheStats,
  audioAssetUri,
  clearAudioAssetCache,
  computeAssetId,
  configureAudioAssetCacheByteBudget,
  DEFAULT_AUDIO_ASSET_CACHE_BYTE_BUDGET,
  deinterleaveChannels,
  deleteAsset,
  InvalidAssetError,
  interleaveChannels,
  listAssetAliases,
  listAssets,
  loadAsset,
  loadAssetMeta,
  saveAsset,
} from '@/persistence/assets';
import { OpfsUnavailableError } from '@/persistence/opfs';
import {
  installMockOpfs,
  type MemoryDirectoryHandle,
  MemoryFileHandle,
  uninstallMockOpfs,
} from './opfs-mock';

/** Reads the assets/ directory of the mock root (creating it on demand). */
async function assetsDir(root: MemoryDirectoryHandle): Promise<MemoryDirectoryHandle> {
  return root.getDirectoryHandle('assets', { create: true });
}

/** A small deterministic stereo buffer pair. */
function stereo(): Float32Array[] {
  return [new Float32Array([0.1, 0.2, 0.3, 0.4]), new Float32Array([-0.1, -0.2, -0.3, -0.4])];
}

describe('audio asset store', () => {
  let root: MemoryDirectoryHandle;

  beforeEach(() => {
    root = installMockOpfs();
    clearAudioAssetCache();
  });

  afterEach(() => {
    uninstallMockOpfs();
    clearAudioAssetCache();
    configureAudioAssetCacheByteBudget(DEFAULT_AUDIO_ASSET_CACHE_BYTE_BUDGET);
  });

  it('saves planar channels and loads them back losslessly', async () => {
    const meta = await saveAsset({ name: 'Guitar take', sampleRate: 48000 }, stereo());
    expect(meta).toMatchObject({
      name: 'Guitar take',
      sampleRate: 48000,
      numChannels: 2,
      numFrames: 4,
    });
    clearAudioAssetCache(); // force the OPFS read path
    const loaded = await loadAsset(meta.id);
    expect(loaded.meta).toEqual(meta);
    expect(loaded.channels).toEqual(stereo());
  });

  it('evicts decoded PCM by byte-budgeted least-recently-used order', async () => {
    configureAudioAssetCacheByteBudget(64); // two 32-byte stereo assets
    await saveAsset({ id: 'asset-a', name: 'A', sampleRate: 48000 }, stereo());
    await saveAsset({ id: 'asset-b', name: 'B', sampleRate: 48000 }, stereo());
    expect(audioAssetCacheStats()).toMatchObject({
      entries: 2,
      bytes: 64,
      ids: ['asset-a', 'asset-b'],
    });

    await loadAsset('asset-a'); // refresh A, making B the eviction candidate
    await saveAsset({ id: 'asset-c', name: 'C', sampleRate: 48000 }, stereo());
    expect(audioAssetCacheStats()).toMatchObject({
      entries: 2,
      bytes: 64,
      ids: ['asset-a', 'asset-c'],
    });
  });

  it('does not retain a decoded asset larger than the cache budget', async () => {
    configureAudioAssetCacheByteBudget(0);
    const meta = await saveAsset({ name: 'Uncached', sampleRate: 48000 }, stereo());
    expect(audioAssetCacheStats()).toMatchObject({ entries: 0, bytes: 0 });
    const first = await loadAsset(meta.id);
    const second = await loadAsset(meta.id);
    expect(second).not.toBe(first);
    expect(audioAssetCacheStats()).toMatchObject({ entries: 0, bytes: 0 });
  });

  it('writes large PCM payloads in bounded chunks', async () => {
    configureAudioAssetCacheByteBudget(0);
    const original = MemoryFileHandle.prototype.createWritable;
    const pcmWriteSizes: number[] = [];
    const spy = vi
      .spyOn(MemoryFileHandle.prototype, 'createWritable')
      .mockImplementation(async function () {
        const writable = await original.call(this);
        if (!this.name.endsWith('.pcm')) return writable;
        const write = writable.write.bind(writable);
        writable.write = (async (chunk: Uint8Array) => {
          pcmWriteSizes.push(chunk.byteLength);
          return write(chunk);
        }) as typeof writable.write;
        return writable;
      });
    const samples = new Float32Array(1024 * 1024 + 16);

    await saveAsset({ id: 'large-pcm', name: 'Large', sampleRate: 48000 }, samples);
    spy.mockRestore();

    expect(pcmWriteSizes).toHaveLength(2);
    expect(Math.max(...pcmWriteSizes)).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(pcmWriteSizes.reduce((sum, size) => sum + size, 0)).toBe(samples.byteLength);
  });

  it('stores a .pcm payload plus a .json sidecar under assets/', async () => {
    const meta = await saveAsset({ name: 'Take', sampleRate: 44100 }, stereo());
    const dir = await assetsDir(root);
    expect(dir.files.has(`${meta.id}.pcm`)).toBe(true);
    expect(dir.files.has(`${meta.id}.json`)).toBe(true);
    // Payload is interleaved float32: 4 frames x 2 channels x 4 bytes.
    expect(dir.files.get(`${meta.id}.pcm`)?.data.length).toBe(32);
    const sidecar = JSON.parse(new TextDecoder().decode(dir.files.get(`${meta.id}.json`)?.data));
    expect(sidecar).toEqual({
      schemaVersion: 2,
      content: {
        id: meta.id,
        sampleRate: 44100,
        numChannels: 2,
        numFrames: 4,
      },
      aliases: [{ name: 'Take' }],
    });
  });

  it('accepts an interleaved buffer with an explicit channel count', async () => {
    const interleaved = interleaveChannels(stereo());
    const meta = await saveAsset(
      { name: 'Interleaved', sampleRate: 48000, numChannels: 2 },
      interleaved,
    );
    expect(meta.numChannels).toBe(2);
    expect(meta.numFrames).toBe(4);
    clearAudioAssetCache();
    const loaded = await loadAsset(meta.id);
    expect(loaded.channels).toEqual(stereo());
  });

  it('derives a deterministic content-hash id', async () => {
    const a = await saveAsset({ name: 'One', sampleRate: 48000 }, stereo());
    const b = await saveAsset({ name: 'Two', sampleRate: 48000 }, stereo());
    expect(a.id).toBe(b.id); // same audio, same id
    expect(a.id).toMatch(/^[0-9a-f]{16}$/);
    const other = await saveAsset(
      { name: 'Other', sampleRate: 44100 }, // same samples, different rate
      stereo(),
    );
    expect(other.id).not.toBe(a.id);
  });

  it('preserves distinct names and tags as aliases without rewriting shared PCM', async () => {
    const first = await saveAsset(
      { name: 'Dry take', sampleRate: 48000, tags: { key: 'Am' } },
      stereo(),
    );
    const dir = await assetsDir(root);
    const pcmBefore = dir.files.get(`${first.id}.pcm`)?.data.slice();
    const second = await saveAsset(
      { name: 'Verse edit', sampleRate: 48000, tags: { bpm: 128 } },
      stereo(),
    );

    expect(second.id).toBe(first.id);
    expect(dir.files.get(`${first.id}.pcm`)?.data).toEqual(pcmBefore);
    expect(await listAssetAliases(first.id)).toEqual([
      { name: 'Dry take', tags: { key: 'Am' } },
      { name: 'Verse edit', tags: { bpm: 128 } },
    ]);
    expect(await loadAssetMeta(first.id)).toMatchObject({
      name: 'Verse edit',
      tags: { bpm: 128 },
    });
  });

  it('rejects an immutable explicit-id content collision and preserves the original', async () => {
    await saveAsset({ id: 'shared', name: 'Original', sampleRate: 48000 }, stereo());
    await expect(
      saveAsset({ id: 'shared', name: 'Collision', sampleRate: 48000 }, [
        new Float32Array([9, 9, 9, 9]),
      ]),
    ).rejects.toThrow(/immutable PCM content collision/);
    clearAudioAssetCache();
    expect((await loadAsset('shared')).channels).toEqual(stereo());
    expect((await loadAssetMeta('shared')).name).toBe('Original');
  });

  it('removes a newly written payload when sidecar publication fails', async () => {
    const original = MemoryFileHandle.prototype.createWritable;
    const spy = vi
      .spyOn(MemoryFileHandle.prototype, 'createWritable')
      .mockImplementation(async function () {
        if (this.name.endsWith('.json')) {
          return {
            write: async () => {
              throw new Error('sidecar write failed');
            },
            close: async () => undefined,
            abort: async () => undefined,
          } as unknown as FileSystemWritableFileStream;
        }
        return original.call(this);
      });
    await expect(saveAsset({ name: 'Broken', sampleRate: 48000 }, stereo())).rejects.toThrow(
      'sidecar write failed',
    );
    spy.mockRestore();

    expect((await assetsDir(root)).files.size).toBe(0);
    expect(await listAssets()).toEqual([]);
  });

  it('computeAssetId is pure and stable', () => {
    const interleaved = interleaveChannels(stereo());
    expect(computeAssetId(interleaved, 48000, 2)).toBe(computeAssetId(interleaved, 48000, 2));
    expect(computeAssetId(interleaved, 48000, 2)).not.toBe(computeAssetId(interleaved, 48000, 1));
  });

  it('honors a caller-provided id and rejects unsafe ids', async () => {
    const meta = await saveAsset({ id: 'my-take_01', name: 'T', sampleRate: 48000 }, stereo());
    expect(meta.id).toBe('my-take_01');
    await expect(
      saveAsset({ id: '../escape', name: 'T', sampleRate: 48000 }, stereo()),
    ).rejects.toThrow(InvalidAssetError);
  });

  it('stores and round-trips tags, including the LUFS loudness measurement', async () => {
    const meta = await saveAsset(
      { name: 'Loop', sampleRate: 48000, tags: { bpm: 128, key: 'Am', lufs: -14.3 } },
      stereo(),
    );
    clearAudioAssetCache(); // force the OPFS read path so validateMeta runs
    expect((await loadAssetMeta(meta.id)).tags).toEqual({ bpm: 128, key: 'Am', lufs: -14.3 });
  });

  it('round-trips a loudness-only tag (no bpm/key)', async () => {
    const meta = await saveAsset(
      { name: 'Loud', sampleRate: 48000, tags: { lufs: -9.5 } },
      stereo(),
    );
    expect(meta.tags).toEqual({ lufs: -9.5 });
    clearAudioAssetCache();
    expect((await loadAssetMeta(meta.id)).tags).toEqual({ lufs: -9.5 });
  });

  it('rejects malformed inputs', async () => {
    await expect(saveAsset({ name: '', sampleRate: 48000 }, stereo())).rejects.toThrow(
      InvalidAssetError,
    );
    await expect(saveAsset({ name: 'T', sampleRate: 0 }, stereo())).rejects.toThrow(
      InvalidAssetError,
    );
    await expect(saveAsset({ name: 'T', sampleRate: 48000 }, [])).rejects.toThrow(
      InvalidAssetError,
    );
    await expect(
      saveAsset({ name: 'T', sampleRate: 48000 }, [
        new Float32Array(3),
        new Float32Array(4), // mismatched channel lengths
      ]),
    ).rejects.toThrow(InvalidAssetError);
    await expect(
      saveAsset({ name: 'T', sampleRate: 48000, numChannels: 2 }, new Float32Array(5)),
    ).rejects.toThrow(InvalidAssetError);
  });

  it('lists assets sorted by name, skipping malformed sidecars', async () => {
    await saveAsset({ id: 'b-id', name: 'Beta', sampleRate: 48000 }, stereo());
    await saveAsset({ id: 'a-id', name: 'Alpha', sampleRate: 48000 }, stereo());
    const dir = await assetsDir(root);
    dir.files.set('broken.json', {
      data: new TextEncoder().encode('not json'),
      lastModified: 1,
    });
    const listed = await listAssets();
    expect(listed.map((a) => a.name)).toEqual(['Alpha', 'Beta']);
  });

  it('loadAsset/loadAssetMeta throw AssetNotFoundError for unknown ids', async () => {
    await expect(loadAsset('missing')).rejects.toThrow(AssetNotFoundError);
    await expect(loadAssetMeta('missing')).rejects.toThrow(AssetNotFoundError);
  });

  it('loadAsset rejects a payload that disagrees with the sidecar', async () => {
    const meta = await saveAsset({ name: 'T', sampleRate: 48000 }, stereo());
    clearAudioAssetCache();
    const dir = await assetsDir(root);
    dir.files.set(`${meta.id}.pcm`, { data: new Uint8Array(4), lastModified: 1 });
    await expect(loadAsset(meta.id)).rejects.toThrow(InvalidAssetError);
  });

  it('deleteAsset removes both files and is idempotent', async () => {
    const meta = await saveAsset({ name: 'T', sampleRate: 48000 }, stereo());
    await deleteAsset(meta.id);
    const dir = await assetsDir(root);
    expect(dir.files.size).toBe(0);
    await expect(loadAsset(meta.id)).rejects.toThrow(AssetNotFoundError);
    await expect(deleteAsset(meta.id)).resolves.toBeUndefined();
  });

  it('throws OpfsUnavailableError without navigator.storage', async () => {
    uninstallMockOpfs();
    await expect(saveAsset({ name: 'T', sampleRate: 48000 }, stereo())).rejects.toThrow(
      OpfsUnavailableError,
    );
    await expect(loadAsset('x')).rejects.toThrow(OpfsUnavailableError);
    await expect(listAssets()).rejects.toThrow(OpfsUnavailableError);
    await expect(deleteAsset('x')).rejects.toThrow(OpfsUnavailableError);
  });
});

describe('audio asset helpers', () => {
  it('interleave/deinterleave round-trip', () => {
    const channels = stereo();
    const interleaved = interleaveChannels(channels);
    expect(interleaved).toEqual(new Float32Array([0.1, -0.1, 0.2, -0.2, 0.3, -0.3, 0.4, -0.4]));
    expect(deinterleaveChannels(interleaved, 2)).toEqual(channels);
  });

  it('deinterleaveChannels validates the channel count', () => {
    expect(() => deinterleaveChannels(new Float32Array(5), 2)).toThrow(InvalidAssetError);
    expect(() => deinterleaveChannels(new Float32Array(4), 0)).toThrow(InvalidAssetError);
  });

  it('audioAssetUri maps ids onto the Project source URI scheme', () => {
    expect(audioAssetUri('abc123')).toBe('asset:abc123');
  });
});
