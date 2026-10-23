import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpfsQuotaExceededError } from '@/persistence/opfs';
import { clearFontCache, loadFont, saveFont } from '@/project/fonts';
import {
  installMockOpfs,
  type MemoryDirectoryHandle,
  MemoryFileHandle,
  uninstallMockOpfs,
} from './opfs-mock';

function sf2Bytes(): Uint8Array {
  const bytes = new Uint8Array(64).fill(3);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x73, 0x66, 0x62, 0x6b], 8);
  return bytes;
}

/** Makes the next write to a file with `suffix` store a few bytes, then fail on quota. */
function failNextWrite(suffix: string) {
  const original = MemoryFileHandle.prototype.createWritable;
  let failed = false;
  return vi.spyOn(MemoryFileHandle.prototype, 'createWritable').mockImplementation(async function (
    this: MemoryFileHandle,
  ) {
    const writable = await original.call(this);
    if (!this.name.endsWith(suffix) || failed) return writable;
    failed = true;
    const write = writable.write.bind(writable);
    writable.write = (async (chunk: Uint8Array) => {
      await write(chunk.subarray(0, Math.min(4, chunk.byteLength)));
      throw new DOMException('storage quota exhausted', 'QuotaExceededError');
    }) as typeof writable.write;
    return writable;
  });
}

describe('SoundFont writes on a full origin', () => {
  let root: MemoryDirectoryHandle;

  beforeEach(() => {
    root = installMockOpfs();
    clearFontCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    uninstallMockOpfs();
    clearFontCache();
  });

  it.each(['.sf2', '.json'])(
    'maps a quota failure on the %s write and leaves nothing behind',
    async (suffix) => {
      const spy = failNextWrite(suffix);

      const failure = saveFont({ name: 'Piano.sf2' }, sf2Bytes());
      await expect(failure).rejects.toBeInstanceOf(OpfsQuotaExceededError);
      await expect(saveFont({ name: 'Piano.sf2' }, sf2Bytes())).resolves.toBeDefined();
      spy.mockRestore();
    },
  );

  it('accepts the same SoundFont again once space is free', async () => {
    const spy = failNextWrite('.sf2');
    await expect(saveFont({ name: 'Piano.sf2' }, sf2Bytes())).rejects.toThrow(/storage is full/);
    const fonts = await root.getDirectoryHandle('fonts', { create: true });
    expect(fonts.files.size).toBe(0);
    spy.mockRestore();

    const meta = await saveFont({ name: 'Piano.sf2' }, sf2Bytes());
    expect(await loadFont(meta.id)).toEqual(sf2Bytes());
  });
});
