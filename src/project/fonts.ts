/**
 * OPFS (origin-private file system) storage for SoundFont (SF2) binaries,
 * parallel to the audio asset store (src/persistence/assets.ts).
 *
 * Each font is a pair of files inside a "fonts/" directory of the
 * origin-private root:
 * - `<id>.sf2`  — the raw SoundFont bytes (fed to Project.loadSoundFont), and
 * - `<id>.json` — the {@link SoundFontMeta} sidecar.
 *
 * Font ids are deterministic: callers may provide one, otherwise a content
 * hash of the bytes is used, so saving the same font twice yields the same id
 * and a single stored copy. Project documents reference fonts by id only
 * (TrackInstrument 'sf2' variant); the bytes never enter the project archive.
 */

import { withPersistenceMutationLock } from '@/persistence/mutation-lock';
import { isOpfsAvailable, OpfsUnavailableError } from '@/persistence/opfs';

/** Directory under the OPFS root that holds the SoundFont files. */
const FONTS_DIR = 'fonts';

/** File extension of the raw SoundFont payload. */
const SF2_EXTENSION = '.sf2';

/** File extension of the JSON metadata sidecar. */
const META_EXTENSION = '.json';

/** Allowed shape of a font id (safe as an OPFS file base name). */
const FONT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Thrown when no stored font matches the requested id. */
export class FontNotFoundError extends Error {
  constructor(id: string) {
    super(`No stored SoundFont with id "${id}"`);
    this.name = 'FontNotFoundError';
  }
}

/** Thrown when font inputs or stored font files are malformed. */
export class InvalidFontError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidFontError';
  }
}

/** Metadata sidecar describing one stored SoundFont. */
export interface SoundFontMeta {
  /** Stable font id (file base name; deterministic content hash by default). */
  id: string;
  /** Display name of the font (e.g. the imported file name). */
  name: string;
  /** Size of the stored SF2 payload in bytes. */
  byteLength: number;
}

/** User-facing name preserved independently from immutable SF2 content. */
export interface SoundFontAlias {
  name: string;
}

interface StoredSoundFontRecord {
  schemaVersion: 2;
  content: { id: string; byteLength: number };
  aliases: SoundFontAlias[];
}

export interface SavedSoundFont {
  meta: SoundFontMeta;
  created: boolean;
}

/** Input accepted by {@link saveFont}. */
export interface SaveFontInput {
  /** Font id override; defaults to the deterministic content hash. */
  id?: string;
  /** Display name of the font. */
  name: string;
}

/** Default upper bound for decoded SF2 bytes kept for playback reuse. */
export const DEFAULT_FONT_CACHE_BYTE_BUDGET = 64 * 1024 * 1024;

/** Default upper bound for compact SoundFont program-manifest lookups. */
export const DEFAULT_FONT_MANIFEST_CACHE_BYTE_BUDGET = 4 * 1024 * 1024;

interface CachedFont {
  meta: SoundFontMeta;
  data: Uint8Array;
}

/** A serializable subset of the runtime's SoundFont program manifest. */
export interface SoundFontManifestEntry {
  channel: number;
  bank: number;
  program: number;
  backend: 'sf2' | 'synth';
  presetName: string;
}

/** In-memory LRU of loaded font bytes, keyed by immutable content id. */
const fontCache = new Map<string, CachedFont>();
let fontCacheBytes = 0;
let fontCacheByteBudget = DEFAULT_FONT_CACHE_BYTE_BUDGET;

/** Compact LRU used by the device picker to avoid reparsing a font per program. */
const fontManifestCache = new Map<
  string,
  { entries: SoundFontManifestEntry[]; byteLength: number }
>();
let fontManifestCacheBytes = 0;
let fontManifestCacheByteBudget = DEFAULT_FONT_MANIFEST_CACHE_BYTE_BUDGET;

function removeCachedFont(id: string): void {
  const existing = fontCache.get(id);
  if (!existing) return;
  fontCache.delete(id);
  fontCacheBytes -= existing.data.byteLength;
}

function cacheFont(meta: SoundFontMeta, data: Uint8Array): void {
  removeCachedFont(meta.id);
  if (data.byteLength > fontCacheByteBudget) return;
  while (fontCacheBytes + data.byteLength > fontCacheByteBudget && fontCache.size > 0) {
    const oldest = fontCache.keys().next().value as string;
    removeCachedFont(oldest);
  }
  fontCache.set(meta.id, { meta: { ...meta }, data });
  fontCacheBytes += data.byteLength;
}

function cachedFont(id: string): CachedFont | undefined {
  const entry = fontCache.get(id);
  if (!entry) return undefined;
  // Map insertion order is the LRU order. Reinsert on every hit.
  fontCache.delete(id);
  fontCache.set(id, entry);
  return entry;
}

function manifestCacheKey(fontId: string, bank: number): string {
  return `${fontId}:${bank}`;
}

function removeCachedManifest(key: string): void {
  const existing = fontManifestCache.get(key);
  if (!existing) return;
  fontManifestCache.delete(key);
  fontManifestCacheBytes -= existing.byteLength;
}

/** Returns a copy of a cached bank manifest, promoting it to most-recent use. */
export function getCachedSoundFontManifest(
  fontId: string,
  bank: number,
): SoundFontManifestEntry[] | null {
  validateFontId(fontId);
  const key = manifestCacheKey(fontId, bank);
  const entry = fontManifestCache.get(key);
  if (!entry) return null;
  fontManifestCache.delete(key);
  fontManifestCache.set(key, entry);
  return entry.entries.map((candidate) => ({ ...candidate }));
}

/** Stores one font-bank program manifest under a small independent LRU budget. */
export function cacheSoundFontManifest(
  fontId: string,
  bank: number,
  entries: readonly SoundFontManifestEntry[],
): void {
  validateFontId(fontId);
  const key = manifestCacheKey(fontId, bank);
  const copied = entries.map((candidate) => ({ ...candidate }));
  const byteLength = new TextEncoder().encode(JSON.stringify(copied)).byteLength;
  removeCachedManifest(key);
  if (byteLength > fontManifestCacheByteBudget) return;
  while (
    fontManifestCacheBytes + byteLength > fontManifestCacheByteBudget &&
    fontManifestCache.size > 0
  ) {
    removeCachedManifest(fontManifestCache.keys().next().value as string);
  }
  fontManifestCache.set(key, { entries: copied, byteLength });
  fontManifestCacheBytes += byteLength;
}

/** Test and diagnostics view of the independently budgeted in-memory caches. */
export function getFontCacheStats(): {
  entries: number;
  byteLength: number;
  budget: number;
  manifestEntries: number;
  manifestByteLength: number;
  manifestBudget: number;
} {
  return {
    entries: fontCache.size,
    byteLength: fontCacheBytes,
    budget: fontCacheByteBudget,
    manifestEntries: fontManifestCache.size,
    manifestByteLength: fontManifestCacheBytes,
    manifestBudget: fontManifestCacheByteBudget,
  };
}

/** Configures cache limits for controlled test and memory-pressure scenarios. */
export function setFontCacheByteBudgetsForTests(
  bytes: number,
  manifestBytes = fontManifestCacheByteBudget,
): void {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    !Number.isSafeInteger(manifestBytes) ||
    manifestBytes < 0
  ) {
    throw new InvalidFontError('Font cache budgets must be non-negative integers');
  }
  fontCacheByteBudget = bytes;
  fontManifestCacheByteBudget = manifestBytes;
  while (fontCacheBytes > bytes && fontCache.size > 0) {
    removeCachedFont(fontCache.keys().next().value as string);
  }
  while (fontManifestCacheBytes > manifestBytes && fontManifestCache.size > 0) {
    removeCachedManifest(fontManifestCache.keys().next().value as string);
  }
}

/** Drops all cached font bytes and program manifests (tests, memory pressure handling). */
export function clearFontCache(): void {
  fontCache.clear();
  fontCacheBytes = 0;
  fontManifestCache.clear();
  fontManifestCacheBytes = 0;
}

/** Throws {@link InvalidFontError} unless the id is a safe file base name. */
function validateFontId(id: string): string {
  if (!FONT_ID_PATTERN.test(id)) {
    throw new InvalidFontError(`Invalid font id: "${id}"`);
  }
  return id;
}

/** 32-bit FNV-1a hash over bytes, with a configurable seed. */
function fnv1a32Bytes(bytes: Uint8Array, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Computes the deterministic content id of a SoundFont: two seeded 32-bit
 * FNV-1a passes over the raw bytes, rendered as 16 hex characters.
 *
 * @param data Raw SF2 bytes.
 * @returns A stable 16-character hex id.
 */
export function computeFontId(data: Uint8Array): string {
  const a = fnv1a32Bytes(data, 0x811c9dc5);
  const b = fnv1a32Bytes(data, 0x01234567);
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** True when an error is a DOMException-style NotFoundError. */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'NotFoundError'
  );
}

/** Resolves (creating on demand) the "fonts/" directory handle. */
async function fontsDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!isOpfsAvailable()) throw new OpfsUnavailableError();
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(FONTS_DIR, { create: true });
}

/** Writes bytes to a (possibly new) file inside the fonts directory. */
async function writeFile(
  dir: FileSystemDirectoryHandle,
  fileName: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await dir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  try {
    // Copy so wasm-backed or shared buffers are never handed to the stream.
    await writable.write(new Uint8Array(bytes));
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

function decodeStoredRecord(
  value: unknown,
  id: string,
): { meta: SoundFontMeta; aliases: SoundFontAlias[]; record: StoredSoundFontRecord } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidFontError(`Font "${id}": metadata sidecar is not a JSON object`);
  }
  const raw = value as Partial<StoredSoundFontRecord> & Partial<SoundFontMeta>;
  if (raw.schemaVersion === 2) {
    if (
      typeof raw.content !== 'object' ||
      raw.content === null ||
      raw.content.id !== id ||
      !Number.isInteger(raw.content.byteLength) ||
      raw.content.byteLength < 0 ||
      !Array.isArray(raw.aliases) ||
      raw.aliases.length === 0 ||
      raw.aliases.some(
        (alias) =>
          typeof alias !== 'object' ||
          alias === null ||
          typeof (alias as SoundFontAlias).name !== 'string' ||
          (alias as SoundFontAlias).name.length === 0,
      )
    ) {
      throw new InvalidFontError(`Font "${id}": malformed metadata sidecar`);
    }
    const aliases = raw.aliases.map((alias) => ({ name: alias.name }));
    const meta = {
      id,
      name: aliases[aliases.length - 1].name,
      byteLength: raw.content.byteLength,
    };
    return {
      meta,
      aliases,
      record: {
        schemaVersion: 2,
        content: { id, byteLength: meta.byteLength },
        aliases,
      },
    };
  }
  if (
    raw.id !== id ||
    typeof raw.name !== 'string' ||
    raw.name.length === 0 ||
    !Number.isInteger(raw.byteLength) ||
    (raw.byteLength as number) < 0
  ) {
    throw new InvalidFontError(`Font "${id}": malformed metadata sidecar`);
  }
  const meta = { id, name: raw.name, byteLength: raw.byteLength as number };
  const aliases = [{ name: meta.name }];
  return {
    meta,
    aliases,
    record: {
      schemaVersion: 2,
      content: { id, byteLength: meta.byteLength },
      aliases,
    },
  };
}

/** Validates a parsed sidecar object into a {@link SoundFontMeta}. */
function validateMeta(value: unknown, id: string): SoundFontMeta {
  return decodeStoredRecord(value, id).meta;
}

async function readOptionalFile(
  dir: FileSystemDirectoryHandle,
  fileName: string,
): Promise<Uint8Array | null> {
  try {
    const handle = await dir.getFileHandle(fileName);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * Stores a SoundFont (SF2 payload + metadata sidecar), replacing any previous
 * font of the same id. Saving identical bytes without an explicit id is
 * idempotent because the default id is a content hash.
 *
 * @param input Font name and optional id override.
 * @param data Raw SF2 bytes (non-empty).
 * @returns The full metadata that was written.
 */
export async function saveFontWithStatusUnlocked(
  input: SaveFontInput,
  data: Uint8Array,
): Promise<SavedSoundFont> {
  if (typeof input.name !== 'string' || input.name.length === 0) {
    throw new InvalidFontError('Font name must not be empty');
  }
  if (data.length === 0) {
    throw new InvalidFontError('Font data must not be empty');
  }
  const id = validateFontId(input.id ?? computeFontId(data));
  const requestedMeta: SoundFontMeta = { id, name: input.name, byteLength: data.length };
  const dir = await fontsDirectory();
  const existingPayload = await readOptionalFile(dir, id + SF2_EXTENSION);
  const existingSidecar = await readOptionalFile(dir, id + META_EXTENSION);
  if (existingPayload !== null && !bytesEqual(existingPayload, data)) {
    throw new InvalidFontError(`Font "${id}": immutable SF2 content collision`);
  }
  if (existingPayload === null && existingSidecar !== null) {
    throw new InvalidFontError(`Font "${id}": metadata exists without its SF2 payload`);
  }
  let aliases: SoundFontAlias[] = [{ name: input.name }];
  if (existingSidecar !== null) {
    let stored: ReturnType<typeof decodeStoredRecord>;
    try {
      stored = decodeStoredRecord(JSON.parse(new TextDecoder().decode(existingSidecar)), id);
    } catch (error) {
      if (error instanceof InvalidFontError) throw error;
      throw new InvalidFontError(`Font "${id}": metadata sidecar is not valid JSON`);
    }
    if (stored.meta.byteLength !== data.byteLength) {
      throw new InvalidFontError(`Font "${id}": immutable content metadata collision`);
    }
    aliases = [...stored.aliases];
    if (!aliases.some((alias) => alias.name === input.name)) aliases.push({ name: input.name });
  }
  const meta: SoundFontMeta = {
    ...requestedMeta,
    name: aliases[aliases.length - 1].name,
  };
  const record: StoredSoundFontRecord = {
    schemaVersion: 2,
    content: { id, byteLength: data.length },
    aliases,
  };
  const created = existingPayload === null;
  if (created) await writeFile(dir, id + SF2_EXTENSION, data);
  try {
    await writeFile(dir, id + META_EXTENSION, new TextEncoder().encode(JSON.stringify(record)));
  } catch (error) {
    if (created) {
      for (const fileName of [id + SF2_EXTENSION, id + META_EXTENSION]) {
        try {
          await dir.removeEntry(fileName);
        } catch (cleanupError) {
          if (!isNotFoundError(cleanupError)) {
            // An orphan payload remains invisible without the sidecar commit marker.
          }
        }
      }
    }
    throw error;
  }
  cacheFont(meta, new Uint8Array(data));
  return { meta: { ...meta }, created };
}

export function saveFontWithStatus(
  input: SaveFontInput,
  data: Uint8Array,
): Promise<SavedSoundFont> {
  return withPersistenceMutationLock(() => saveFontWithStatusUnlocked(input, data));
}

export async function saveFont(input: SaveFontInput, data: Uint8Array): Promise<SoundFontMeta> {
  return (await saveFontWithStatus(input, data)).meta;
}

/**
 * Reads a font's metadata sidecar.
 *
 * @param id Font id.
 * @returns The stored metadata.
 * @throws FontNotFoundError when no such font is stored.
 */
export async function loadFontMeta(id: string): Promise<SoundFontMeta> {
  validateFontId(id);
  const cached = cachedFont(id);
  if (cached) return { ...cached.meta };
  const dir = await fontsDirectory();
  let file: File;
  try {
    const handle = await dir.getFileHandle(id + META_EXTENSION);
    file = await handle.getFile();
  } catch (error) {
    if (isNotFoundError(error)) throw new FontNotFoundError(id);
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(await file.arrayBuffer()));
  } catch {
    throw new InvalidFontError(`Font "${id}": metadata sidecar is not valid JSON`);
  }
  return validateMeta(parsed, id);
}

/** Lists every preserved display alias for one immutable SoundFont payload. */
export async function listFontAliases(id: string): Promise<SoundFontAlias[]> {
  validateFontId(id);
  const dir = await fontsDirectory();
  const bytes = await readOptionalFile(dir, id + META_EXTENSION);
  if (bytes === null) throw new FontNotFoundError(id);
  try {
    return decodeStoredRecord(JSON.parse(new TextDecoder().decode(bytes)), id).aliases.map(
      (alias) => ({ ...alias }),
    );
  } catch (error) {
    if (error instanceof InvalidFontError) throw error;
    throw new InvalidFontError(`Font "${id}": metadata sidecar is not valid JSON`);
  }
}

/**
 * Reads a font's SF2 bytes. Results are cached in memory; treat the returned
 * buffer as immutable (copy before mutating).
 *
 * @param id Font id.
 * @returns The stored SF2 bytes.
 * @throws FontNotFoundError when no such font is stored.
 * @throws InvalidFontError when the payload size disagrees with the sidecar.
 */
export async function loadFont(id: string, options: { cache?: boolean } = {}): Promise<Uint8Array> {
  validateFontId(id);
  if (options.cache !== false) {
    const cached = cachedFont(id);
    if (cached) return cached.data;
  }
  const meta = await loadFontMeta(id);
  const dir = await fontsDirectory();
  let file: File;
  try {
    const handle = await dir.getFileHandle(id + SF2_EXTENSION);
    file = await handle.getFile();
  } catch (error) {
    if (isNotFoundError(error)) throw new FontNotFoundError(id);
    throw error;
  }
  const data = new Uint8Array(await file.arrayBuffer());
  if (data.length !== meta.byteLength) {
    throw new InvalidFontError(
      `Font "${id}": payload is ${data.length} bytes, expected ${meta.byteLength}`,
    );
  }
  if (options.cache !== false) cacheFont(meta, data);
  return data;
}

/**
 * Lists the stored fonts (their metadata sidecars), sorted by name then id.
 * Files with malformed sidecars are skipped.
 */
export async function listFonts(): Promise<SoundFontMeta[]> {
  const dir = await fontsDirectory();
  const out: SoundFontMeta[] = [];
  for await (const [entryName, handle] of dir.entries()) {
    if (handle.kind !== 'file' || !entryName.endsWith(META_EXTENSION)) continue;
    const id = entryName.slice(0, -META_EXTENSION.length);
    try {
      const file = await handle.getFile();
      const parsed = JSON.parse(new TextDecoder().decode(await file.arrayBuffer()));
      out.push(validateMeta(parsed, id));
    } catch {
      // Skip unreadable or malformed sidecars; the listing stays usable.
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return out;
}

/**
 * Deletes a stored font (payload + sidecar). Deleting an id that is not
 * stored is a no-op, so callers can treat deletion as idempotent.
 *
 * @param id Font id.
 */
export async function deleteFontUnlocked(id: string): Promise<void> {
  validateFontId(id);
  const dir = await fontsDirectory();
  removeCachedFont(id);
  for (const key of fontManifestCache.keys()) {
    if (key.startsWith(`${id}:`)) removeCachedManifest(key);
  }
  for (const fileName of [id + SF2_EXTENSION, id + META_EXTENSION]) {
    try {
      await dir.removeEntry(fileName);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }
}

export function deleteFont(id: string): Promise<void> {
  return withPersistenceMutationLock(() => deleteFontUnlocked(id));
}
