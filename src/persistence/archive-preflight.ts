import { type UnzipFileInfo, type Unzipped, unzip, unzipSync } from 'fflate';

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

const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY = 0x02014b50;
const ZIP64_SENTINEL = 0xffffffff;

function findEndOfCentralDirectory(view: DataView): number {
  // Match fflate's bounded backwards scan. A ZIP comment is limited to 65,535
  // bytes, so anything older than this cannot be the active EOCD record.
  for (let offset = view.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY) return offset;
    if (view.byteLength - offset > 65_558) break;
  }
  throw new ArchivePreflightError('Archive is not a readable zip file');
}

function hasRange(view: DataView, offset: number, length: number): boolean {
  return (
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    offset >= 0 &&
    length >= 0 &&
    offset <= view.byteLength &&
    length <= view.byteLength - offset
  );
}

/**
 * Rejects central-directory aliases before fflate sees any entry. fflate's
 * filter exposes sizes and compression but not the local-header offset, while
 * two central records can point at one payload under different names. Such an
 * archive would make the retained expansion budget count the same bytes more
 * than once and can multiply the output object graph during unpacking.
 *
 * This parser intentionally accepts only the regular ZIP32 directory shape.
 * The application-wide archive byte ceiling is far below ZIP64's useful range;
 * rejecting an incomplete ZIP64 directory is safer than allowing an offset we
 * cannot account for to reach the decompressor.
 */
function rejectCentralDirectoryAliases(bytes: Uint8Array, maxEntries: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  if (!hasRange(view, eocd, 22)) {
    throw new ArchivePreflightError('Archive has a truncated end-of-central-directory record');
  }
  const entryCount = view.getUint16(eocd + 8, true);
  const centralDirectoryBytes = view.getUint32(eocd + 12, true);
  const centralDirectoryOffset = view.getUint32(eocd + 16, true);
  if (
    entryCount === 0xffff ||
    centralDirectoryBytes === ZIP64_SENTINEL ||
    centralDirectoryOffset === ZIP64_SENTINEL
  ) {
    throw new ArchivePreflightError('ZIP64 archives are not supported by archive preflight');
  }
  if (entryCount > maxEntries) {
    throw new ArchivePreflightError(`Archive has too many entries (limit ${maxEntries})`);
  }
  if (!hasRange(view, centralDirectoryOffset, centralDirectoryBytes)) {
    throw new ArchivePreflightError('Archive has a truncated central directory');
  }
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectoryBytes;
  const localOffsets = new Set<number>();
  let cursor = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (!hasRange(view, cursor, 46) || view.getUint32(cursor, true) !== ZIP_CENTRAL_DIRECTORY) {
      throw new ArchivePreflightError('Archive has a malformed central-directory record');
    }
    const nameBytes = view.getUint16(cursor + 28, true);
    const extraBytes = view.getUint16(cursor + 30, true);
    const commentBytes = view.getUint16(cursor + 32, true);
    const recordBytes = 46 + nameBytes + extraBytes + commentBytes;
    if (!hasRange(view, cursor, recordBytes) || cursor + recordBytes > centralDirectoryEnd) {
      throw new ArchivePreflightError('Archive has a truncated central-directory record');
    }
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    if (localHeaderOffset === ZIP64_SENTINEL) {
      throw new ArchivePreflightError('ZIP64 local-header offsets are not supported');
    }
    if (localOffsets.has(localHeaderOffset)) {
      throw new ArchivePreflightError('Archive contains aliased local-header offsets');
    }
    localOffsets.add(localHeaderOffset);
    cursor += recordBytes;
  }
  if (cursor !== centralDirectoryEnd) {
    throw new ArchivePreflightError('Archive has extra bytes in the central directory');
  }
}

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
  filter: (entry: UnzipFileInfo) => boolean;
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
      if (entry.compression !== 0 && entry.compression !== 8) {
        throw new ArchivePreflightError(
          `Archive entry uses unsupported compression method: ${entry.name}`,
        );
      }
      const expandedBytes = entry.compression === 0 ? entry.size : entry.originalSize;
      if (
        !Number.isSafeInteger(entry.size) ||
        !Number.isSafeInteger(expandedBytes) ||
        entry.size < 0 ||
        expandedBytes < 0
      ) {
        throw new ArchivePreflightError(`Archive entry has invalid size metadata: ${entry.name}`);
      }
      if (entries + 1 > resolved.maxEntries) {
        throw new ArchivePreflightError(
          `Archive has too many entries (limit ${resolved.maxEntries})`,
        );
      }
      if (entry.size > resolved.maxCompressedBytes) {
        throw new ArchivePreflightError(
          `Archive entry compressed payload is too large: ${entry.name} (${entry.size} bytes)`,
        );
      }
      if (expandedBytes > resolved.maxEntryBytes) {
        throw new ArchivePreflightError(
          `Archive entry is too large: ${entry.name} (${expandedBytes} bytes)`,
        );
      }
      if (compressedBytes + entry.size > resolved.maxCompressedBytes) {
        throw new ArchivePreflightError(
          `Archive compressed payloads exceed ${resolved.maxCompressedBytes} bytes`,
        );
      }
      if (uncompressedBytes + expandedBytes > resolved.maxUncompressedBytes) {
        throw new ArchivePreflightError(
          `Archive expands beyond ${resolved.maxUncompressedBytes} bytes`,
        );
      }
      if (expandedBytes === 0) {
        if (entry.size > EMPTY_ENTRY_COMPRESSED_CEILING) {
          throw new ArchivePreflightError(
            `Archive entry declares zero size but carries ${entry.size} compressed bytes: ${entry.name}`,
          );
        }
      } else {
        const ratio = expandedBytes / Math.max(entry.size, 1);
        if (ratio > resolved.maxCompressionRatio) {
          throw new ArchivePreflightError(
            `Archive entry compression ratio is unsafe: ${entry.name} (${ratio.toFixed(1)}:1)`,
          );
        }
      }
      seen.add(entry.name);
      entries += 1;
      compressedBytes += entry.size;
      uncompressedBytes += expandedBytes;
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
  rejectCentralDirectoryAliases(bytes, resolved.maxEntries);
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
    rejectCentralDirectoryAliases(bytes, resolved.maxEntries);
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
