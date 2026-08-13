import { strFromU8, strToU8, unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { PayloadMemoryMeter } from '@/lib/payload-memory';
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

  it('does not detach caller-owned entry bytes while compression runs', async () => {
    const writer = createStreamingZipWriter({ mtime: '2000-01-01T12:00:00Z' });
    const source = new Uint8Array([1, 2, 3, 4]);

    await writer.add('source.bin', source);
    await writer.close();

    expect(source).toEqual(new Uint8Array([1, 2, 3, 4]));
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

  it('rejects an in-flight entry and close when its signal aborts', async () => {
    const controller = new AbortController();
    const writer = createStreamingZipWriter({
      mtime: '2000-01-01T12:00:00Z',
      signal: controller.signal,
    });
    const pending = writer.add('large.bin', new Uint8Array(4 * 1024 * 1024));
    controller.abort(new DOMException('cancelled', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(writer.close()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects close and releases chunks when the final archive publish fails', async () => {
    const meter = new PayloadMemoryMeter({ label: 'test', budgetBytes: 1024 * 1024 });
    const retain = meter.retain.bind(meter);
    vi.spyOn(meter, 'retain').mockImplementation((bytes, unit) => {
      if (unit === 'ZIP archive publish') throw new Error('publish accounting failed');
      return retain(bytes, unit);
    });
    const writer = createStreamingZipWriter({
      mtime: '2000-01-01T12:00:00Z',
      meter,
    });

    await writer.add('entry.txt', strToU8('entry'));
    await expect(writer.close()).rejects.toThrow('publish accounting failed');
    expect(meter.snapshot().activeBytes).toBe(0);
    expect(() => writer.add('later.txt', strToU8('later'))).toThrow('closed');
    await expect(writer.close()).rejects.toThrow('publish accounting failed');
  });
});
