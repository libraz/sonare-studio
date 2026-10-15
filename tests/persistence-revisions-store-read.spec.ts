import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readProjectRevisionStoreUnlocked,
  saveProjectRevision,
  writeProjectRevisionIndexBytesUnlocked,
} from '@/persistence/revisions';
import { installMockOpfs, MemoryFileHandle, uninstallMockOpfs } from './opfs-mock';

describe('revision store snapshot read', () => {
  beforeEach(() => {
    installMockOpfs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    uninstallMockOpfs();
  });

  it('reads the index file once and derives both its bytes and entries from it', async () => {
    const saved = await saveProjectRevision('Song', 'v1', new Uint8Array([1, 2, 3]), 1000);
    const getFile = vi.spyOn(MemoryFileHandle.prototype, 'getFile');

    const snapshot = await readProjectRevisionStoreUnlocked();

    expect(getFile.mock.contexts.filter((handle) => handle.name === 'index.json')).toHaveLength(1);
    expect(snapshot.index).toEqual([saved]);
    expect(snapshot.indexBytes).not.toBeNull();
    expect(JSON.parse(new TextDecoder().decode(snapshot.indexBytes as Uint8Array))).toEqual([
      saved,
    ]);
  });

  it('reports an empty index and null bytes when none was published', async () => {
    const snapshot = await readProjectRevisionStoreUnlocked();

    expect(snapshot.index).toEqual([]);
    expect(snapshot.indexBytes).toBeNull();
  });

  it('treats a corrupt index as empty while still returning its raw bytes', async () => {
    const corrupt = new TextEncoder().encode('{not json');
    await writeProjectRevisionIndexBytesUnlocked(corrupt);

    const snapshot = await readProjectRevisionStoreUnlocked();

    expect(snapshot.index).toEqual([]);
    expect(Array.from(snapshot.indexBytes as Uint8Array)).toEqual(Array.from(corrupt));
  });
});
