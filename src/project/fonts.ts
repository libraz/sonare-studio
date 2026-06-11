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

/** Input accepted by {@link saveFont}. */
export interface SaveFontInput {
  /** Font id override; defaults to the deterministic content hash. */
  id?: string;
  /** Display name of the font. */
  name: string;
}

/** In-memory cache of loaded fonts (prerendering re-loads often). */
const fontCache = new Map<string, { meta: SoundFontMeta; data: Uint8Array }>();

/** Drops all cached font bytes (tests, memory pressure handling). */
export function clearFontCache(): void {
  fontCache.clear();
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
  } finally {
    await writable.close();
  }
}

/** Validates a parsed sidecar object into a {@link SoundFontMeta}. */
function validateMeta(value: unknown, id: string): SoundFontMeta {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidFontError(`Font "${id}": metadata sidecar is not a JSON object`);
  }
  const meta = value as Partial<SoundFontMeta>;
  if (
    meta.id !== id ||
    typeof meta.name !== 'string' ||
    !Number.isInteger(meta.byteLength) ||
    (meta.byteLength as number) < 0
  ) {
    throw new InvalidFontError(`Font "${id}": malformed metadata sidecar`);
  }
  return { id, name: meta.name, byteLength: meta.byteLength as number };
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
export async function saveFont(input: SaveFontInput, data: Uint8Array): Promise<SoundFontMeta> {
  if (typeof input.name !== 'string' || input.name.length === 0) {
    throw new InvalidFontError('Font name must not be empty');
  }
  if (data.length === 0) {
    throw new InvalidFontError('Font data must not be empty');
  }
  const id = validateFontId(input.id ?? computeFontId(data));
  const meta: SoundFontMeta = { id, name: input.name, byteLength: data.length };
  const dir = await fontsDirectory();
  await writeFile(dir, id + SF2_EXTENSION, data);
  await writeFile(dir, id + META_EXTENSION, new TextEncoder().encode(JSON.stringify(meta)));
  fontCache.set(id, { meta, data: new Uint8Array(data) });
  return { ...meta };
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
  const cached = fontCache.get(id);
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

/**
 * Reads a font's SF2 bytes. Results are cached in memory; treat the returned
 * buffer as immutable (copy before mutating).
 *
 * @param id Font id.
 * @returns The stored SF2 bytes.
 * @throws FontNotFoundError when no such font is stored.
 * @throws InvalidFontError when the payload size disagrees with the sidecar.
 */
export async function loadFont(id: string): Promise<Uint8Array> {
  validateFontId(id);
  const cached = fontCache.get(id);
  if (cached) return cached.data;
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
  fontCache.set(id, { meta, data });
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
export async function deleteFont(id: string): Promise<void> {
  validateFontId(id);
  const dir = await fontsDirectory();
  fontCache.delete(id);
  for (const fileName of [id + SF2_EXTENSION, id + META_EXTENSION]) {
    try {
      await dir.removeEntry(fileName);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }
}
