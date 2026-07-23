import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpfsUnavailableError } from '@/persistence/opfs';
import {
  cacheSoundFontManifest,
  clearFontCache,
  computeFontId,
  DEFAULT_FONT_CACHE_BYTE_BUDGET,
  DEFAULT_FONT_MANIFEST_CACHE_BYTE_BUDGET,
  deleteFont,
  FontNotFoundError,
  getCachedSoundFontManifest,
  getFontCacheStats,
  InvalidFontError,
  listFontAliases,
  listFontPayloads,
  listFonts,
  loadFont,
  loadFontMeta,
  saveFont,
  setFontCacheByteBudgetsForTests,
} from '@/project/fonts';
import {
  installMockOpfs,
  type MemoryDirectoryHandle,
  MemoryFileHandle,
  uninstallMockOpfs,
} from './opfs-mock';

const BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);

describe('SoundFont store', () => {
  let root: MemoryDirectoryHandle;

  beforeEach(() => {
    root = installMockOpfs();
    setFontCacheByteBudgetsForTests(
      DEFAULT_FONT_CACHE_BYTE_BUDGET,
      DEFAULT_FONT_MANIFEST_CACHE_BYTE_BUDGET,
    );
    clearFontCache();
  });

  afterEach(() => {
    uninstallMockOpfs();
    clearFontCache();
    setFontCacheByteBudgetsForTests(
      DEFAULT_FONT_CACHE_BYTE_BUDGET,
      DEFAULT_FONT_MANIFEST_CACHE_BYTE_BUDGET,
    );
  });

  it('saves a font and reads it back', async () => {
    const meta = await saveFont({ name: 'GM Basic.sf2' }, BYTES);
    expect(meta).toEqual({ id: computeFontId(BYTES), name: 'GM Basic.sf2', byteLength: 8 });

    clearFontCache(); // force the OPFS read path
    const data = await loadFont(meta.id);
    expect(Array.from(data)).toEqual(Array.from(BYTES));
    expect(await loadFontMeta(meta.id)).toEqual(meta);

    const dir = await root.getDirectoryHandle('fonts');
    expect([...dir.files.keys()].sort()).toEqual([`${meta.id}.json`, `${meta.id}.sf2`]);
  });

  it('uses a deterministic content id (idempotent saves)', async () => {
    const a = await saveFont({ name: 'A' }, BYTES);
    const b = await saveFont({ name: 'B' }, BYTES);
    expect(b.id).toBe(a.id);
    expect(await listFonts()).toHaveLength(1);
    expect(await listFontAliases(a.id)).toEqual([{ name: 'A' }, { name: 'B' }]);
    expect(await loadFontMeta(a.id)).toMatchObject({ name: 'B' });
  });

  it('rejects an explicit-id content collision without replacing the font', async () => {
    await saveFont({ id: 'shared', name: 'Original' }, BYTES);
    await expect(
      saveFont({ id: 'shared', name: 'Collision' }, new Uint8Array([9, 9, 9])),
    ).rejects.toThrow(/immutable SF2 content collision/);
    clearFontCache();
    expect(Array.from(await loadFont('shared'))).toEqual(Array.from(BYTES));
    expect((await loadFontMeta('shared')).name).toBe('Original');
  });

  it('removes a new SF2 payload when sidecar publication fails', async () => {
    const original = MemoryFileHandle.prototype.createWritable;
    const spy = vi
      .spyOn(MemoryFileHandle.prototype, 'createWritable')
      .mockImplementation(async function () {
        if (this.name.endsWith('.json')) {
          return {
            write: async () => {
              throw new Error('font sidecar failed');
            },
            close: async () => undefined,
            abort: async () => undefined,
          } as unknown as FileSystemWritableFileStream;
        }
        return original.call(this);
      });
    await expect(saveFont({ name: 'Broken' }, BYTES)).rejects.toThrow('font sidecar failed');
    spy.mockRestore();

    const dir = await root.getDirectoryHandle('fonts');
    expect([...dir.files.keys()]).toEqual([]);
  });

  it('accepts an explicit id and lists fonts sorted by name', async () => {
    await saveFont({ id: 'zeta', name: 'Zeta' }, BYTES);
    await saveFont({ id: 'alpha', name: 'Alpha' }, new Uint8Array([9]));
    const listed = await listFonts();
    expect(listed.map((f) => f.name)).toEqual(['Alpha', 'Zeta']);
  });

  it('lists payloads even when their metadata sidecar is missing', async () => {
    const dir = await root.getDirectoryHandle('fonts', { create: true });
    dir.files.set('orphan.sf2', { data: new Uint8Array([1, 2, 3]), lastModified: 1 });

    expect(await listFontPayloads()).toEqual([{ id: 'orphan', byteLength: 3 }]);
  });

  it('throws FontNotFoundError for unknown ids', async () => {
    await expect(loadFont('00000000deadbeef')).rejects.toBeInstanceOf(FontNotFoundError);
    await expect(loadFontMeta('00000000deadbeef')).rejects.toBeInstanceOf(FontNotFoundError);
  });

  it('rejects empty data, empty names and unsafe ids', async () => {
    await expect(saveFont({ name: '' }, BYTES)).rejects.toBeInstanceOf(InvalidFontError);
    await expect(saveFont({ name: 'X' }, new Uint8Array(0))).rejects.toBeInstanceOf(
      InvalidFontError,
    );
    await expect(saveFont({ id: '../evil', name: 'X' }, BYTES)).rejects.toBeInstanceOf(
      InvalidFontError,
    );
  });

  it('deleteFont is idempotent and drops both files', async () => {
    const meta = await saveFont({ name: 'GM' }, BYTES);
    await deleteFont(meta.id);
    await deleteFont(meta.id); // no-op
    await expect(loadFont(meta.id)).rejects.toBeInstanceOf(FontNotFoundError);
    const dir = await root.getDirectoryHandle('fonts');
    expect([...dir.files.keys()]).toEqual([]);
  });

  it('caches loaded fonts in memory', async () => {
    const meta = await saveFont({ name: 'GM' }, BYTES);
    const first = await loadFont(meta.id);
    const second = await loadFont(meta.id);
    expect(second).toBe(first);
  });

  it('evicts least-recently-used font bytes within the configured byte budget', async () => {
    setFontCacheByteBudgetsForTests(8);
    const first = await saveFont({ id: 'first', name: 'First' }, new Uint8Array(8).fill(1));
    await saveFont({ id: 'second', name: 'Second' }, new Uint8Array(8).fill(2));

    expect(getFontCacheStats()).toMatchObject({ entries: 1, byteLength: 8, budget: 8 });
    const reloaded = await loadFont(first.id);
    expect(reloaded).toEqual(new Uint8Array(8).fill(1));
    expect(getFontCacheStats()).toMatchObject({ entries: 1, byteLength: 8 });
  });

  it('does not retain a font larger than the byte budget', async () => {
    setFontCacheByteBudgetsForTests(4);
    const meta = await saveFont({ name: 'Large' }, new Uint8Array(8).fill(3));
    const first = await loadFont(meta.id);
    const second = await loadFont(meta.id);

    expect(second).not.toBe(first);
    expect(getFontCacheStats()).toMatchObject({ entries: 0, byteLength: 0 });
  });

  it('keeps program manifests in their own bounded LRU', () => {
    setFontCacheByteBudgetsForTests(1024, 1_000);
    cacheSoundFontManifest('fontaaaa00000001', 0, [
      { channel: 0, bank: 0, program: 1, backend: 'sf2', presetName: 'Piano' },
    ]);
    const manifest = getCachedSoundFontManifest('fontaaaa00000001', 0);

    expect(manifest).toEqual([
      { channel: 0, bank: 0, program: 1, backend: 'sf2', presetName: 'Piano' },
    ]);
    expect(getFontCacheStats()).toMatchObject({ entries: 0, manifestEntries: 1 });
  });

  it('fails with OpfsUnavailableError when OPFS is missing', async () => {
    uninstallMockOpfs();
    await expect(saveFont({ name: 'GM' }, BYTES)).rejects.toBeInstanceOf(OpfsUnavailableError);
    installMockOpfs(); // afterEach uninstalls again
  });
});
