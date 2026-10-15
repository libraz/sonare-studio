import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ArchivePreflightError, preflightAndUnzipInWorker } from '@/persistence/archive-preflight';
import { decodeSzdInWorker, decodeSzdWithMetaInWorker, encodeSzd } from '@/persistence/szd';
import { PROJECT_DOCUMENT_SCHEMA_VERSION, type ProjectDocument } from '@/project/serialization';

const MEDIA_ENTRY = 'assets/aaaaaaaaaaaaaaaa.pcm';

function emptyDocument(): ProjectDocument {
  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name: 'Selective',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks: [],
    markers: [],
    sections: [],
  };
}

/** An archive whose media payload is compressed data that cannot be inflated. */
function archiveWithUninflatableMedia(): Uint8Array {
  const bytes = encodeSzd(
    emptyDocument(),
    { savedAt: new Date('2025-01-01T00:00:00Z') },
    {
      assets: [
        {
          id: 'aaaaaaaaaaaaaaaa',
          meta: strToU8('{}'),
          pcm: new Uint8Array(200_000),
        },
      ],
      fonts: [],
    },
  );
  const name = strToU8(MEDIA_ENTRY);
  let nameAt = -1;
  for (let index = 0; index + name.length <= bytes.length && nameAt < 0; index += 1) {
    if (name.every((byte, offset) => bytes[index + offset] === byte)) nameAt = index;
  }
  const header = new DataView(bytes.buffer, bytes.byteOffset + nameAt - 30);
  const dataStart = nameAt + header.getUint16(26, true) + header.getUint16(28, true);
  // BTYPE 3 is a reserved deflate block type, which the decompressor rejects.
  bytes.fill(0xff, dataStart, dataStart + 8);
  return bytes;
}

describe('selective archive inflation', () => {
  it('inflates only the selected entries but still reports every entry', async () => {
    const archive = zipSync({ 'a.txt': strToU8('a'), 'b.txt': strToU8('b') });

    const result = await preflightAndUnzipInWorker(
      archive,
      {},
      undefined,
      (name) => name === 'a.txt',
    );

    expect(Object.keys(result.entries)).toEqual(['a.txt']);
    expect(result.report.entries).toBe(2);
  });

  it('still rejects an unselected entry that violates the limits', async () => {
    const archive = zipSync({ 'a.txt': strToU8('a'), 'big.bin': new Uint8Array(4096) });

    await expect(
      preflightAndUnzipInWorker(
        archive,
        { maxEntryBytes: 1024 },
        undefined,
        (name) => name === 'a.txt',
      ),
    ).rejects.toBeInstanceOf(ArchivePreflightError);
  });

  it('decodes the document without inflating bundled media', async () => {
    const archive = archiveWithUninflatableMedia();

    await expect(decodeSzdInWorker(archive)).resolves.toMatchObject({ name: 'Selective' });
    const decoded = await decodeSzdWithMetaInWorker(archive);
    expect(decoded.document.name).toBe('Selective');
    expect(decoded.meta?.savedAt).toBeDefined();
  });
});
