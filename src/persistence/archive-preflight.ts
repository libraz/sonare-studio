import { type Unzipped, unzip, unzipSync } from 'fflate';

/** Resource ceilings checked from ZIP metadata before each entry is inflated. */
export interface ArchiveLimits {
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxCompressionRatio: number;
  maxPathLength: number;
}

export interface ArchivePreflightReport {
  compressedBytes: number;
  uncompressedBytes: number;
  entries: number;
}

export interface PreflightedArchive {
  entries: Unzipped;
  report: ArchivePreflightReport;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = Object.freeze({
  maxCompressedBytes: 1024 * 1024 * 1024,
  maxUncompressedBytes: 1024 * 1024 * 1024,
  maxEntries: 10_000,
  maxEntryBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 2000,
  maxPathLength: 1024,
});

export class ArchivePreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchivePreflightError';
  }
}

/**
 * A genuinely empty entry deflates to at most a handful of header bytes. An
 * archive that declares `originalSize === 0` while carrying a substantial
 * compressed payload is lying about its expansion to slip past the ratio guard
 * (which would otherwise treat a zero uncompressed size as a 1:1 ratio), so any
 * zero-sized entry beyond this compressed ceiling is rejected outright.
 */
const EMPTY_ENTRY_COMPRESSED_CEILING = 64;

function safeEntryName(name: string, maxPathLength: number): void {
  if (name.length === 0 || name.length > maxPathLength || name.includes('\0')) {
    throw new ArchivePreflightError('Archive contains an invalid or overlong entry path');
  }
  const normalized = name.replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new ArchivePreflightError(`Archive contains an unsafe entry path: ${name}`);
  }
}

function resolveLimits(
  bytes: Uint8Array,
  limits: Partial<ArchiveLimits>,
  signal?: AbortSignal,
): ArchiveLimits {
  const resolved = { ...DEFAULT_ARCHIVE_LIMITS, ...limits };
  signal?.throwIfAborted();
  if (bytes.byteLength > resolved.maxCompressedBytes) {
    throw new ArchivePreflightError(
      `Archive is too large (${bytes.byteLength} compressed bytes; limit ${resolved.maxCompressedBytes})`,
    );
  }
  return resolved;
}

function archiveEntryValidator(
  resolved: ArchiveLimits,
  signal?: AbortSignal,
): {
  filter: (entry: { name: string; size: number; originalSize: number }) => boolean;
  report: () => ArchivePreflightReport;
} {
  const seen = new Set<string>();
  let entries = 0;
  let compressedBytes = 0;
  let uncompressedBytes = 0;
  return {
    filter(entry): boolean {
      signal?.throwIfAborted();
      safeEntryName(entry.name, resolved.maxPathLength);
      if (seen.has(entry.name)) {
        throw new ArchivePreflightError(`Archive contains duplicate entry: ${entry.name}`);
      }
      seen.add(entry.name);
      entries += 1;
      compressedBytes += entry.size;
      uncompressedBytes += entry.originalSize;
      if (entries > resolved.maxEntries) {
        throw new ArchivePreflightError(
          `Archive has too many entries (limit ${resolved.maxEntries})`,
        );
      }
      if (entry.originalSize > resolved.maxEntryBytes) {
        throw new ArchivePreflightError(
          `Archive entry is too large: ${entry.name} (${entry.originalSize} bytes)`,
        );
      }
      if (uncompressedBytes > resolved.maxUncompressedBytes) {
        throw new ArchivePreflightError(
          `Archive expands beyond ${resolved.maxUncompressedBytes} bytes`,
        );
      }
      if (entry.originalSize === 0) {
        if (entry.size > EMPTY_ENTRY_COMPRESSED_CEILING) {
          throw new ArchivePreflightError(
            `Archive entry declares zero size but carries ${entry.size} compressed bytes: ${entry.name}`,
          );
        }
      } else {
        const ratio = entry.originalSize / Math.max(entry.size, 1);
        if (ratio > resolved.maxCompressionRatio) {
          throw new ArchivePreflightError(
            `Archive entry compression ratio is unsafe: ${entry.name} (${ratio.toFixed(1)}:1)`,
          );
        }
      }
      return true;
    },
    report: () => ({ entries, compressedBytes, uncompressedBytes }),
  };
}

function readableArchiveError(error: unknown, signal?: AbortSignal): Error {
  if (error instanceof ArchivePreflightError) return error;
  if (signal?.aborted) {
    return signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Archive processing cancelled.', 'AbortError');
  }
  return new ArchivePreflightError('Archive is not a readable zip file');
}

/**
 * Validates ZIP entry/count/size/ratio metadata and inflates the archive once.
 * fflate invokes the filter with compressed and original sizes before it
 * allocates each output entry, so oversized or high-ratio entries are rejected
 * before their payload is expanded.
 */
export function preflightAndUnzip(
  bytes: Uint8Array,
  limits: Partial<ArchiveLimits> = {},
  signal?: AbortSignal,
): PreflightedArchive {
  const resolved = resolveLimits(bytes, limits, signal);
  const validator = archiveEntryValidator(resolved, signal);
  let extracted: Unzipped;
  try {
    extracted = unzipSync(bytes, { filter: validator.filter });
  } catch (error) {
    throw readableArchiveError(error, signal);
  }
  signal?.throwIfAborted();
  return {
    entries: extracted,
    report: validator.report(),
  };
}

/**
 * Runs bounded ZIP expansion through fflate's asynchronous worker path.
 * The returned terminator is wired to AbortSignal so imports do not leave a
 * decompressor alive after the owning UI operation has been cancelled.
 */
export function preflightAndUnzipInWorker(
  bytes: Uint8Array,
  limits: Partial<ArchiveLimits> = {},
  signal?: AbortSignal,
): Promise<PreflightedArchive> {
  let resolved: ArchiveLimits;
  try {
    resolved = resolveLimits(bytes, limits, signal);
  } catch (error) {
    return Promise.reject(error);
  }
  const validator = archiveEntryValidator(resolved, signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    let terminate: (() => void) | undefined;
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(readableArchiveError(error, signal));
    };
    const onAbort = (): void => {
      terminate?.();
      fail(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      terminate = unzip(bytes, { filter: validator.filter }, (error, entries) => {
        if (error) {
          fail(error);
          return;
        }
        if (signal?.aborted) {
          fail(signal.reason);
          return;
        }
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ entries, report: validator.report() });
      });
      if (signal?.aborted) onAbort();
    } catch (error) {
      fail(error);
    }
  });
}
