import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { preflightAndUnzip, preflightAndUnzipInWorker } from '@/persistence/archive-preflight';

/** Inserts a 20-byte ZIP64 EOCD locator right before a ZIP32 archive's EOCD record. */
function withZip64Locator(zip: Uint8Array): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record found');
  const locator = new Uint8Array(20);
  new DataView(locator.buffer).setUint32(0, 0x07064b50, true);
  const patched = new Uint8Array(zip.length + 20);
  patched.set(zip.subarray(0, eocd), 0);
  patched.set(locator, eocd);
  patched.set(zip.subarray(eocd), eocd + 20);
  return patched;
}

describe('archive preflight ZIP64 locator', () => {
  it('rejects a ZIP32 archive carrying a ZIP64 locator before unzipping', async () => {
    const archive = withZip64Locator(zipSync({ entry: new Uint8Array([1, 2, 3]) }));

    expect(() => preflightAndUnzip(archive)).toThrow(/ZIP64 archives are not supported/);
    await expect(preflightAndUnzipInWorker(archive)).rejects.toThrow(
      /ZIP64 archives are not supported/,
    );
  });

  it('still accepts the same archive without the locator', () => {
    const archive = zipSync({ entry: new Uint8Array([1, 2, 3]) });
    expect(Object.keys(preflightAndUnzip(archive).entries)).toEqual(['entry']);
  });
});
