import { strFromU8, strToU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createStreamingZipWriter } from '@/lib/streaming-zip';

describe('streaming ZIP writer', () => {
  it('writes entries incrementally and reports their retained-byte statistics', async () => {
    const writer = createStreamingZipWriter({ mtime: '2000-01-01T12:00:00Z' });

    await writer.add('first.txt', strToU8('first'));
    await writer.add('second.txt', strToU8('second'));
    const bytes = await writer.close();

    expect(
      Object.fromEntries(
        Object.entries(unzipSync(bytes)).map(([name, value]) => [name, strFromU8(value)]),
      ),
    ).toEqual({
      'first.txt': 'first',
      'second.txt': 'second',
    });
    expect(writer.stats()).toMatchObject({ entries: 2, uncompressedBytes: 11 });
    expect(writer.stats().compressedBytes).toBeGreaterThan(0);
  });

  it('enforces format-provided entry limits before accepting more input', async () => {
    const writer = createStreamingZipWriter({
      mtime: '2000-01-01T12:00:00Z',
      maxEntries: 1,
      createLimitError: (message) => new Error(`limited: ${message}`),
    });

    await writer.add('one.txt', strToU8('one'));
    expect(() => writer.add('two.txt', strToU8('two'))).toThrow('limited: ZIP entry count');
    await expect(writer.close()).resolves.toBeInstanceOf(Uint8Array);
  });
});
