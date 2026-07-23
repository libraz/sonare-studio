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
