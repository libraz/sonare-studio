/**
 * Bounded incremental ZIP writer shared by exports and browser backups.
 *
 * fflate's `Zip` emits chunks asynchronously.  Keeping the lifecycle,
 * cancellation and accounting here prevents the individual archive formats
 * from drifting on those details.
 */

import { AsyncZipDeflate, Zip } from 'fflate';
import type { PayloadMemoryMeter } from './payload-memory';

export interface StreamingZipLimits {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxUncompressedBytes?: number;
  maxCompressedBytes?: number;
}

export interface StreamingZipStats {
  entries: number;
  uncompressedBytes: number;
  compressedBytes: number;
}

export interface StreamingZipWriterOptions extends StreamingZipLimits {
  /** Timestamp applied to every entry for deterministic archive output. */
  mtime: string | Date;
  signal?: AbortSignal;
  /** Optional retained-output meter (used by stems exports). */
  meter?: PayloadMemoryMeter;
  /** Converts limit failures to the archive format's public error type. */
  createLimitError?: (message: string) => Error;
}

/** A sequential streaming ZIP writer that collects the final archive bytes. */
export interface StreamingZipWriter {
  add(name: string, bytes: Uint8Array): Promise<void>;
  close(): Promise<Uint8Array>;
  abort(reason?: unknown): void;
  stats(): StreamingZipStats;
}

function concatenate(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Creates a ZIP writer which serializes entry compression and accounts for
 * both input and retained output before the archive is published.
 */
export function createStreamingZipWriter(options: StreamingZipWriterOptions): StreamingZipWriter {
  const chunks: Uint8Array[] = [];
  const chunkReleases: Array<() => void> = [];
  const names = new Set<string>();
  const pendingEntries = new Set<Promise<void>>();
  const limitError = (message: string): Error =>
    options.createLimitError?.(message) ?? new RangeError(message);
  let entries = 0;
  let uncompressedBytes = 0;
  let compressedBytes = 0;
  let closed = false;
  let settled = false;
  let resolveResult!: (bytes: Uint8Array) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<Uint8Array>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // An AbortSignal can settle this before callers reach close().
  void result.catch(() => {});
  const releaseChunks = (): void => {
    chunks.length = 0;
    while (chunkReleases.length > 0) chunkReleases.pop()?.();
  };
  const finishError = (error: unknown): void => {
    if (settled) return;
    settled = true;
    closed = true;
    options.signal?.removeEventListener('abort', onAbort);
    releaseChunks();
    try {
      zip.terminate();
    } catch {
      // Preserve the original compression or publish error.
    }
    rejectResult(error);
  };
  const zip = new Zip((error, chunk, final) => {
    if (settled) return;
    if (error) {
      finishError(error);
      return;
    }
    try {
      const releaseCopyPeak = options.meter?.retain(
        chunk.byteLength * 2,
        `compressed ZIP chunk copy ${chunks.length + 1}`,
      );
      const copy = new Uint8Array(chunk);
      releaseCopyPeak?.();
      const release = options.meter?.retain(
        copy.byteLength,
        `compressed ZIP chunk ${chunks.length + 1}`,
      );
      chunks.push(copy);
      compressedBytes += copy.byteLength;
      if (release) chunkReleases.push(release);
      if (
        options.maxCompressedBytes !== undefined &&
        compressedBytes > options.maxCompressedBytes
      ) {
        finishError(limitError('ZIP compressed size exceeds its configured limit'));
        return;
      }
    } catch (memoryError) {
      finishError(memoryError);
      return;
    }
    if (final) {
      let releasePublishPeak: (() => void) | undefined;
      try {
        releasePublishPeak = options.meter?.retain(compressedBytes, 'ZIP archive publish');
        if (settled) return;
        const bytes = concatenate(chunks, compressedBytes);
        releaseChunks();
        settled = true;
        closed = true;
        options.signal?.removeEventListener('abort', onAbort);
        resolveResult(bytes);
      } catch (publishError) {
        finishError(publishError);
      } finally {
        releasePublishPeak?.();
      }
    }
  });
  const abortError = (): unknown =>
    options.signal?.reason ?? new DOMException('ZIP creation cancelled.', 'AbortError');
  function onAbort(): void {
    finishError(abortError());
  }
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  return {
    add(name, bytes): Promise<void> {
      options.signal?.throwIfAborted();
      if (closed) throw new Error('ZIP writer is closed');
      if (names.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
      if (options.maxEntries !== undefined && entries + 1 > options.maxEntries) {
        throw limitError('ZIP entry count exceeds its configured limit');
      }
      if (options.maxEntryBytes !== undefined && bytes.byteLength > options.maxEntryBytes) {
        throw limitError(`ZIP entry "${name}" exceeds its configured limit`);
      }
      if (
        options.maxUncompressedBytes !== undefined &&
        uncompressedBytes + bytes.byteLength > options.maxUncompressedBytes
      ) {
        throw limitError('ZIP expanded size exceeds its configured limit');
      }
      names.add(name);
      entries += 1;
      uncompressedBytes += bytes.byteLength;
      const file = new AsyncZipDeflate(name, { level: 6 });
      file.mtime = new Date(options.mtime);
      zip.add(file);
      const downstream = file.ondata;
      // fflate may transfer the buffer supplied to push() to its compression
      // worker. Preserve the caller-owned entry bytes (asset PCM/SF2 data is
      // often reused after a portable export) and transfer only this copy.
      const input = new Uint8Array(bytes);
      const completion = new Promise<void>((resolve, reject) => {
        const onEntryAbort = (): void => reject(abortError());
        options.signal?.addEventListener('abort', onEntryAbort, { once: true });
        file.ondata = (error, chunk, final) => {
          downstream(error, chunk, final);
          if (error) {
            options.signal?.removeEventListener('abort', onEntryAbort);
            reject(error);
          } else if (final) {
            options.signal?.removeEventListener('abort', onEntryAbort);
            resolve();
          }
        };
        try {
          file.push(input, true);
        } catch (error) {
          options.signal?.removeEventListener('abort', onEntryAbort);
          reject(error);
        }
      });
      pendingEntries.add(completion);
      void completion.then(
        () => pendingEntries.delete(completion),
        () => pendingEntries.delete(completion),
      );
      return completion;
    },
    async close(): Promise<Uint8Array> {
      if (closed) return result;
      closed = true;
      try {
        options.signal?.throwIfAborted();
        // A compression or publish callback can reject result before an
        // in-flight entry reports its own completion. Race that result so close
        // cannot remain pending after the writer has already failed.
        await Promise.race([
          Promise.all(pendingEntries),
          result.then(
            () => undefined,
            (error) => {
              throw error;
            },
          ),
        ]);
        options.signal?.throwIfAborted();
        zip.end();
        return await result;
      } catch (error) {
        finishError(error);
        throw error;
      }
    },
    abort(reason?: unknown): void {
      finishError(reason ?? new DOMException('ZIP creation cancelled.', 'AbortError'));
    },
    stats(): StreamingZipStats {
      return { entries, uncompressedBytes, compressedBytes };
    },
  };
}
