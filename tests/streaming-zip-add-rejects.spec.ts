import { strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createStreamingZipWriter } from '@/lib/streaming-zip';

const MTIME = '2000-01-01T12:00:00Z';

/** Calls add and reports whether it threw synchronously instead of returning a promise. */
function addOutcome(
  writer: ReturnType<typeof createStreamingZipWriter>,
  name: string,
): { threw: boolean; promise?: Promise<void> } {
  try {
    return { threw: false, promise: writer.add(name, strToU8('x')) };
  } catch {
    return { threw: true };
  }
}

describe('streaming ZIP add failures', () => {
  it('rejects a duplicate entry name', async () => {
    const writer = createStreamingZipWriter({ mtime: MTIME });
    await writer.add('a.txt', strToU8('a'));
    const outcome = addOutcome(writer, 'a.txt');
    expect(outcome.threw).toBe(false);
    await expect(outcome.promise).rejects.toThrow('Duplicate ZIP entry');
    await writer.close();
  });

  it('rejects when the entry count limit is exceeded', async () => {
    const writer = createStreamingZipWriter({ mtime: MTIME, maxEntries: 1 });
    await writer.add('a.txt', strToU8('a'));
    const outcome = addOutcome(writer, 'b.txt');
    expect(outcome.threw).toBe(false);
    await expect(outcome.promise).rejects.toThrow('entry count');
    await writer.close();
  });

  it('rejects when the writer is closed', async () => {
    const writer = createStreamingZipWriter({ mtime: MTIME });
    await writer.add('a.txt', strToU8('a'));
    await writer.close();
    const outcome = addOutcome(writer, 'b.txt');
    expect(outcome.threw).toBe(false);
    await expect(outcome.promise).rejects.toThrow('closed');
  });

  it('rejects when the signal is already aborted', async () => {
    const controller = new AbortController();
    const writer = createStreamingZipWriter({ mtime: MTIME, signal: controller.signal });
    controller.abort();
    const outcome = addOutcome(writer, 'a.txt');
    expect(outcome.threw).toBe(false);
    await expect(outcome.promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});
