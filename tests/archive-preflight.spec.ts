import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  ArchivePreflightError,
  preflightAndUnzip,
  preflightAndUnzipInWorker,
} from '@/persistence/archive-preflight';

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

  it('honors an already-aborted operation before parsing', () => {
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled', 'AbortError'));
    expect(() => preflightAndUnzip(new Uint8Array(), {}, controller.signal)).toThrowError(
      DOMException,
    );
    expect(() => preflightAndUnzip(new Uint8Array([1]))).toThrow(ArchivePreflightError);
  });
});
