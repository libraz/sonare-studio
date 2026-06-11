/**
 * Small hashing/canonicalization helpers shared by cache-key builders in the
 * project layer (instrument and mixer-strip identity).
 */

/**
 * 32-bit FNV-1a hash of a string.
 *
 * @param input String to hash.
 * @returns Unsigned 32-bit hash value.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Renders a 32-bit FNV-1a hash of a string as 8 hex characters. */
export function fnv1a32Hex(input: string): string {
  return fnv1a32(input).toString(16).padStart(8, '0');
}

/**
 * Serializes a plain JSON value with object keys sorted recursively, so two
 * structurally equal values always produce the same string (insertion order
 * of object fields does not matter).
 *
 * @param value Plain JSON-able value (no cycles).
 * @returns Deterministic JSON string.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const body = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${body.join(',')}}`;
}
