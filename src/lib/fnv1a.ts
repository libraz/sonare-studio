/** Standard 32-bit FNV-1a offset basis. */
export const FNV1A_OFFSET_BASIS = 0x811c9dc5;

/** Standard 32-bit FNV-1a prime. */
export const FNV1A_PRIME = 0x01000193;

/** Second seed for the paired pass that widens a content id to 64 bits. */
export const FNV1A_SECOND_SEED = 0x01234567;

/**
 * 32-bit FNV-1a hash over bytes, with a configurable seed so a prior pass can
 * be chained in.
 *
 * @param bytes Bytes to hash.
 * @param seed Initial hash state; defaults to the FNV offset basis.
 * @returns Unsigned 32-bit hash.
 */
export function fnv1a32Bytes(bytes: Uint8Array, seed: number = FNV1A_OFFSET_BASIS): number {
  let hash = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, FNV1A_PRIME);
  }
  return hash >>> 0;
}

/**
 * 32-bit FNV-1a hash over a string's UTF-16 code units.
 *
 * @param input String to hash.
 * @returns Unsigned 32-bit hash.
 */
export function fnv1a32(input: string): number {
  let hash = FNV1A_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV1A_PRIME);
  }
  return hash >>> 0;
}
