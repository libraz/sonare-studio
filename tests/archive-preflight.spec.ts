import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  ArchivePreflightError,
  preflightAndUnzip,
  preflightAndUnzipInWorker,
} from '@/persistence/archive-preflight';

/**
 * Zeros the uncompressed-size field of the first central-directory record so the
 * archive under-reports its expansion. fflate's unzip reads entry sizes from the
 * central directory, so this is what the preflight filter observes.
 */
function zeroCentralDirUncompressedSize(zip: Uint8Array): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record found');
  const cdOffset = view.getUint32(eocd + 16, true);
  if (view.getUint32(cdOffset, true) !== 0x02014b50) {
    throw new Error('central-directory header not found at declared offset');
  }
  const patched = zip.slice();
  new DataView(patched.buffer).setUint32(cdOffset + 24, 0, true);
  return patched;
}

function centralDirectoryRecords(zip: Uint8Array): number[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record found');
  const count = view.getUint16(eocd + 8, true);
  let cursor = view.getUint32(eocd + 16, true);
  const records: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error('central-directory header not found');
    }
    records.push(cursor);
    cursor +=
      46 +
      view.getUint16(cursor + 28, true) +
      view.getUint16(cursor + 30, true) +
      view.getUint16(cursor + 32, true);
  }
  return records;
}

describe('archive preflight', () => {
  it('returns entries and exact size/count metadata after one bounded expansion', () => {
    const zip = zipSync({
      'project.xml': strToU8('<Project/>'),
      'audio/take.wav': new Uint8Array([1, 2, 3, 4]),
    });
    const parsed = preflightAndUnzip(zip);

    expect(Object.keys(parsed.entries).sort()).toEqual(['audio/take.wav', 'project.xml']);
    expect(parsed.report.entries).toBe(2);
    expect(parsed.report.uncompressedBytes).toBe(14);
    expect(parsed.report.compressedBytes).toBeGreaterThan(0);
  });

  it('rejects zip bombs by declared expansion ratio before returning payloads', () => {
    const zip = zipSync({ 'bomb.bin': new Uint8Array(1024 * 1024) });
    expect(() => preflightAndUnzip(zip, { maxCompressionRatio: 10 })).toThrow(
      /compression ratio is unsafe/,
    );
  });

  it('expands through the cancellable asynchronous worker path', async () => {
    const zip = zipSync({ 'project.xml': strToU8('<Project/>') });
    await expect(preflightAndUnzipInWorker(zip)).resolves.toMatchObject({
      report: { entries: 1, uncompressedBytes: 10 },
    });

    const controller = new AbortController();
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(preflightAndUnzipInWorker(zip, {}, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('enforces entry, individual-file, total-size, and safe-path ceilings', () => {
    const twoFiles = zipSync({ a: new Uint8Array(8), b: new Uint8Array(8) });
    expect(() => preflightAndUnzip(twoFiles, { maxEntries: 1 })).toThrow(/too many entries/);
    expect(() => preflightAndUnzip(twoFiles, { maxEntryBytes: 4 })).toThrow(/entry is too large/);
    expect(() => preflightAndUnzip(twoFiles, { maxUncompressedBytes: 12 })).toThrow(
      /expands beyond/,
    );
    const unsafe = zipSync({ '../escape': new Uint8Array(1) });
    expect(() => preflightAndUnzip(unsafe)).toThrow(/unsafe entry path/);
  });

  it('accepts a genuinely empty entry whose declared size is zero', () => {
    const zip = zipSync({ 'empty.txt': new Uint8Array(0), 'note.txt': strToU8('hi') });
    const parsed = preflightAndUnzip(zip);
    expect(Object.keys(parsed.entries).sort()).toEqual(['empty.txt', 'note.txt']);
    expect(parsed.report.entries).toBe(2);
  });

  it('rejects an entry that declares zero size while carrying a compressed payload', () => {
    // A 1 MiB run of zeros compresses to a small but non-trivial DEFLATE stream.
    // Patch its central-directory uncompressed-size field to zero so the archive
    // lies about its expansion — the ratio guard used to wave zero-size entries
    // through unconditionally, letting such headers slip past.
    const zip = zipSync({ 'lie.bin': new Uint8Array(1024 * 1024) });
    const patched = zeroCentralDirUncompressedSize(zip);
    expect(() => preflightAndUnzip(patched)).toThrow(/declares zero size but carries/);
  });

  it('budgets stored entries by their actual copied payload, not originalSize', async () => {
    const payload = new Uint8Array(32);
    const stored = zipSync({ 'stored.bin': [payload, { level: 0 }] });
    const records = centralDirectoryRecords(stored);
    const patched = stored.slice();
    new DataView(patched.buffer).setUint32(records[0]! + 24, 1, true);

    expect(preflightAndUnzip(patched).report.uncompressedBytes).toBe(payload.byteLength);
    expect(() => preflightAndUnzip(patched, { maxEntryBytes: payload.byteLength - 1 })).toThrow(
      /entry is too large/,
    );
    await expect(
      preflightAndUnzipInWorker(patched, { maxUncompressedBytes: payload.byteLength - 1 }),
    ).rejects.toThrow(/expands beyond/);
  });

  it('rejects central-directory entries that alias one local payload', async () => {
    const archive = zipSync({ first: new Uint8Array([1, 2]), second: new Uint8Array([3, 4]) });
    const records = centralDirectoryRecords(archive);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const firstLocalOffset = view.getUint32(records[0]! + 42, true);
    const patched = archive.slice();
    new DataView(patched.buffer).setUint32(records[1]! + 42, firstLocalOffset, true);

    expect(() => preflightAndUnzip(patched)).toThrow(/aliased local-header offsets/);
    await expect(preflightAndUnzipInWorker(patched)).rejects.toThrow(
      /aliased local-header offsets/,
    );
  });

  it('honors an already-aborted operation before parsing', () => {
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled', 'AbortError'));
    expect(() => preflightAndUnzip(new Uint8Array(), {}, controller.signal)).toThrowError(
      DOMException,
    );
    expect(() => preflightAndUnzip(new Uint8Array([1]))).toThrow(ArchivePreflightError);
  });
});
