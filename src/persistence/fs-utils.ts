/** Shared filesystem/archive safety primitives. */

/** Safe base-name shape for OPFS media and archive entries. */
export const MEDIA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when a browser filesystem operation reports a missing entry. */
export function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'NotFoundError'
  );
}

/** Bytewise equality without allocating an intermediate string or buffer. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** True when an OPFS write ran out of origin storage quota. */
export function isQuotaExceededError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'QuotaExceededError'
  );
}

/** True for an array whose every entry is a string. */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** A collision-resistant id: a UUID where available, otherwise time plus randomness. */
export function createRandomId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Chunk size for streaming bytes into or out of OPFS files. */
export const OPFS_IO_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Writes bytes to a (possibly new) file in `dir`, aborting the stream on
 * failure. Each chunk is copied so wasm-backed or shared input is never
 * retained by the stream, while a multi-gigabyte payload is never duplicated
 * at once.
 */
export async function writeOpfsFile(
  dir: FileSystemDirectoryHandle,
  fileName: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await dir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += OPFS_IO_CHUNK_BYTES) {
      await writable.write(
        bytes.slice(offset, Math.min(bytes.byteLength, offset + OPFS_IO_CHUNK_BYTES)),
      );
    }
    await writable.close();
  } catch (error) {
    try {
      await writable.abort?.();
    } catch {
      // Preserve the original write/close failure.
    }
    throw error;
  }
}
