/**
 * OPFS (origin-private file system) storage for audio assets.
 *
 * Each asset is a pair of files inside an "assets/" directory of the
 * origin-private root:
 * - `<id>.pcm`  — raw interleaved little-endian float32 frames (the same
 *   layout the engine's OPFS clip page provider reads), and
 * - `<id>.json` — the {@link AudioAssetMeta} sidecar.
 *
 * Asset ids are deterministic: callers may provide one, otherwise a content
 * hash of the samples (plus sample rate and channel count) is used, so saving
 * the same audio twice yields the same id and a single stored copy. Project
 * documents reference assets by id only; the PCM bytes never enter the
 * project archive (see src/project/serialization.ts).
 */

import { isOpfsAvailable, OpfsUnavailableError } from './opfs';

/** Directory under the OPFS root that holds the audio assets. */
const ASSETS_DIR = 'assets';

/** File extension of the raw interleaved float32 PCM payload. */
const PCM_EXTENSION = '.pcm';

/** File extension of the JSON metadata sidecar. */
const META_EXTENSION = '.json';

/** Bytes per sample (32-bit float). */
const BYTES_PER_SAMPLE = 4;

/** Allowed shape of an asset id (safe as an OPFS file base name). */
const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Thrown when no stored asset matches the requested id. */
export class AssetNotFoundError extends Error {
  constructor(id: string) {
    super(`No stored audio asset with id "${id}"`);
    this.name = 'AssetNotFoundError';
  }
}

/** Thrown when asset inputs or stored asset files are malformed. */
export class InvalidAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAssetError';
  }
}

/** Optional analysis tags attached to an asset on import. */
export interface AudioAssetTags {
  /** Detected tempo in BPM. */
  bpm?: number;
  /** Detected musical key (display string, e.g. "Am"). */
  key?: string;
}

/** Metadata sidecar describing one stored audio asset. */
export interface AudioAssetMeta {
  /** Stable asset id (file base name; deterministic content hash by default). */
  id: string;
  /** Display name of the asset (e.g. the imported file name). */
  name: string;
  /** Sample rate of the stored PCM in Hz. */
  sampleRate: number;
  /** Number of interleaved channels (>= 1; stereo is preserved as 2). */
  numChannels: number;
  /** Number of frames (samples per channel). */
  numFrames: number;
  /** Optional analysis tags (tempo, key, ...). */
  tags?: AudioAssetTags;
}

/** Input accepted by {@link saveAsset}; numChannels/numFrames are derived. */
export interface SaveAssetInput {
  /** Asset id override; defaults to the deterministic content hash. */
  id?: string;
  /** Display name of the asset. */
  name: string;
  /** Sample rate of the provided audio in Hz (> 0). */
  sampleRate: number;
  /** Channel count when `audio` is an interleaved buffer (default 1). */
  numChannels?: number;
  /** Optional analysis tags stored in the sidecar. */
  tags?: AudioAssetTags;
}

/** A loaded asset: its metadata plus planar per-channel sample buffers. */
export interface LoadedAudioAsset {
  /** The stored metadata sidecar. */
  meta: AudioAssetMeta;
  /** Planar channel buffers; treat as immutable (they may be cached). */
  channels: Float32Array[];
}

/**
 * Maps an asset id to the source URI recorded on wasm Project audio sources,
 * so a Project clip's source can be traced back to the stored asset.
 */
export function audioAssetUri(assetId: string): string {
  return `asset:${assetId}`;
}

/** In-memory cache of loaded assets (playback re-schedules often). */
const audioCache = new Map<string, LoadedAudioAsset>();

/** Drops all cached asset audio (tests, memory pressure handling). */
export function clearAudioAssetCache(): void {
  audioCache.clear();
}

/** Throws {@link InvalidAssetError} unless the id is a safe file base name. */
function validateAssetId(id: string): string {
  if (!ASSET_ID_PATTERN.test(id)) {
    throw new InvalidAssetError(`Invalid asset id: "${id}"`);
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
 * Computes the deterministic content id of an audio buffer: two seeded
 * 32-bit FNV-1a passes over the raw sample bytes plus a header covering
 * sample rate and channel count, rendered as 16 hex characters.
 *
 * @param interleaved Interleaved samples (frame-major).
 * @param sampleRate Sample rate in Hz.
 * @param numChannels Channel count.
 * @returns A stable 16-character hex id.
 */
export function computeAssetId(
  interleaved: Float32Array,
  sampleRate: number,
  numChannels: number,
): string {
  const header = new TextEncoder().encode(
    `f32|sr=${sampleRate}|ch=${numChannels}|n=${interleaved.length}|`,
  );
  const body = new Uint8Array(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength);
  const a = fnv1a32Bytes(body, fnv1a32Bytes(header, 0x811c9dc5));
  const b = fnv1a32Bytes(body, fnv1a32Bytes(header, 0x01234567));
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/**
 * Interleaves planar channel buffers into one frame-major buffer.
 *
 * @param channels Planar channel buffers of equal length (>= 1 channel).
 * @returns Interleaved samples (L R L R ... for stereo).
 * @throws InvalidAssetError on empty input or mismatched channel lengths.
 */
export function interleaveChannels(channels: ReadonlyArray<Float32Array>): Float32Array {
  if (channels.length === 0) {
    throw new InvalidAssetError('Audio must have at least one channel');
  }
  const frames = channels[0].length;
  for (const channel of channels) {
    if (channel.length !== frames) {
      throw new InvalidAssetError('All channels must have the same length');
    }
  }
  const out = new Float32Array(frames * channels.length);
  for (let c = 0; c < channels.length; c++) {
    const channel = channels[c];
    for (let i = 0; i < frames; i++) {
      out[i * channels.length + c] = channel[i];
    }
  }
  return out;
}

/**
 * Splits an interleaved buffer into planar per-channel buffers.
 *
 * @param interleaved Interleaved samples (frame-major).
 * @param numChannels Channel count (positive integer dividing the length).
 * @returns One Float32Array per channel.
 */
export function deinterleaveChannels(
  interleaved: Float32Array,
  numChannels: number,
): Float32Array[] {
  if (!Number.isInteger(numChannels) || numChannels < 1) {
    throw new InvalidAssetError(`numChannels must be a positive integer, got ${numChannels}`);
  }
  if (interleaved.length % numChannels !== 0) {
    throw new InvalidAssetError(
      `Interleaved length ${interleaved.length} is not divisible by ${numChannels} channels`,
    );
  }
  const frames = interleaved.length / numChannels;
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      out[i] = interleaved[i * numChannels + c];
    }
    channels.push(out);
  }
  return channels;
}

/** True when an error is a DOMException-style NotFoundError. */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'NotFoundError'
  );
}

/** Resolves (creating on demand) the "assets/" directory handle. */
async function assetsDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!isOpfsAvailable()) throw new OpfsUnavailableError();
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(ASSETS_DIR, { create: true });
}

/** Writes bytes to a (possibly new) file inside the assets directory. */
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

/** Validates a parsed sidecar object into an {@link AudioAssetMeta}. */
function validateMeta(value: unknown, id: string): AudioAssetMeta {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidAssetError(`Asset "${id}": metadata sidecar is not a JSON object`);
  }
  const meta = value as Partial<AudioAssetMeta>;
  if (
    meta.id !== id ||
    typeof meta.name !== 'string' ||
    typeof meta.sampleRate !== 'number' ||
    !Number.isFinite(meta.sampleRate) ||
    meta.sampleRate <= 0 ||
    !Number.isInteger(meta.numChannels) ||
    (meta.numChannels as number) < 1 ||
    !Number.isInteger(meta.numFrames) ||
    (meta.numFrames as number) < 0
  ) {
    throw new InvalidAssetError(`Asset "${id}": malformed metadata sidecar`);
  }
  const out: AudioAssetMeta = {
    id,
    name: meta.name,
    sampleRate: meta.sampleRate,
    numChannels: meta.numChannels as number,
    numFrames: meta.numFrames as number,
  };
  if (typeof meta.tags === 'object' && meta.tags !== null) {
    const tags: AudioAssetTags = {};
    const raw = meta.tags as AudioAssetTags;
    if (typeof raw.bpm === 'number' && Number.isFinite(raw.bpm) && raw.bpm > 0) tags.bpm = raw.bpm;
    if (typeof raw.key === 'string' && raw.key.length > 0) tags.key = raw.key;
    if (tags.bpm !== undefined || tags.key !== undefined) out.tags = tags;
  }
  return out;
}

/**
 * Stores an audio asset (PCM payload + metadata sidecar), replacing any
 * previous asset of the same id. Saving identical audio without an explicit
 * id is idempotent because the default id is a content hash.
 *
 * @param input Asset name, sample rate, optional id/tags (and channel count
 *   when `audio` is interleaved).
 * @param audio Planar channel buffers, or one interleaved frame-major buffer.
 * @returns The full metadata that was written.
 */
export async function saveAsset(
  input: SaveAssetInput,
  audio: Float32Array | ReadonlyArray<Float32Array>,
): Promise<AudioAssetMeta> {
  if (typeof input.name !== 'string' || input.name.length === 0) {
    throw new InvalidAssetError('Asset name must not be empty');
  }
  if (!Number.isFinite(input.sampleRate) || input.sampleRate <= 0) {
    throw new InvalidAssetError(`Asset sampleRate must be finite and > 0, got ${input.sampleRate}`);
  }
  let interleaved: Float32Array;
  let numChannels: number;
  if (audio instanceof Float32Array) {
    numChannels = input.numChannels ?? 1;
    if (!Number.isInteger(numChannels) || numChannels < 1) {
      throw new InvalidAssetError(`numChannels must be a positive integer, got ${numChannels}`);
    }
    if (audio.length % numChannels !== 0) {
      throw new InvalidAssetError(
        `Interleaved length ${audio.length} is not divisible by ${numChannels} channels`,
      );
    }
    interleaved = audio;
  } else {
    interleaved = interleaveChannels(audio);
    numChannels = audio.length;
    if (input.numChannels !== undefined && input.numChannels !== numChannels) {
      throw new InvalidAssetError(
        `numChannels ${input.numChannels} does not match the ${numChannels} provided channels`,
      );
    }
  }
  const numFrames = interleaved.length / numChannels;
  const id = validateAssetId(
    input.id ?? computeAssetId(interleaved, input.sampleRate, numChannels),
  );
  const meta: AudioAssetMeta = {
    id,
    name: input.name,
    sampleRate: input.sampleRate,
    numChannels,
    numFrames,
  };
  if (input.tags && (input.tags.bpm !== undefined || input.tags.key !== undefined)) {
    meta.tags = { ...input.tags };
  }

  const dir = await assetsDirectory();
  const pcmBytes = new Uint8Array(
    interleaved.buffer,
    interleaved.byteOffset,
    interleaved.byteLength,
  );
  await writeFile(dir, id + PCM_EXTENSION, pcmBytes);
  await writeFile(dir, id + META_EXTENSION, new TextEncoder().encode(JSON.stringify(meta)));
  audioCache.set(id, { meta, channels: deinterleaveChannels(interleaved, numChannels) });
  return { ...meta, ...(meta.tags ? { tags: { ...meta.tags } } : {}) };
}

/**
 * Reads an asset's metadata sidecar.
 *
 * @param id Asset id.
 * @returns The stored metadata.
 * @throws AssetNotFoundError when no such asset is stored.
 */
export async function loadAssetMeta(id: string): Promise<AudioAssetMeta> {
  validateAssetId(id);
  const cached = audioCache.get(id);
  if (cached) return cached.meta;
  const dir = await assetsDirectory();
  let file: File;
  try {
    const handle = await dir.getFileHandle(id + META_EXTENSION);
    file = await handle.getFile();
  } catch (error) {
    if (isNotFoundError(error)) throw new AssetNotFoundError(id);
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(await file.arrayBuffer()));
  } catch {
    throw new InvalidAssetError(`Asset "${id}": metadata sidecar is not valid JSON`);
  }
  return validateMeta(parsed, id);
}

/**
 * Reads an asset's metadata and PCM payload, deinterleaved to planar channel
 * buffers. Results are cached in memory; treat the returned buffers as
 * immutable (copy before mutating).
 *
 * @param id Asset id.
 * @returns Metadata plus planar channel buffers.
 * @throws AssetNotFoundError when no such asset is stored.
 * @throws InvalidAssetError when the PCM size disagrees with the sidecar.
 */
export async function loadAsset(id: string): Promise<LoadedAudioAsset> {
  validateAssetId(id);
  const cached = audioCache.get(id);
  if (cached) return cached;
  const meta = await loadAssetMeta(id);
  const dir = await assetsDirectory();
  let file: File;
  try {
    const handle = await dir.getFileHandle(id + PCM_EXTENSION);
    file = await handle.getFile();
  } catch (error) {
    if (isNotFoundError(error)) throw new AssetNotFoundError(id);
    throw error;
  }
  const bytes = await file.arrayBuffer();
  const expectedBytes = meta.numFrames * meta.numChannels * BYTES_PER_SAMPLE;
  if (bytes.byteLength !== expectedBytes) {
    throw new InvalidAssetError(
      `Asset "${id}": PCM payload is ${bytes.byteLength} bytes, expected ${expectedBytes}`,
    );
  }
  const channels = deinterleaveChannels(new Float32Array(bytes), meta.numChannels);
  const loaded: LoadedAudioAsset = { meta, channels };
  audioCache.set(id, loaded);
  return loaded;
}

/**
 * Lists the stored assets (their metadata sidecars), sorted by name then id.
 * Files with malformed sidecars are skipped.
 */
export async function listAssets(): Promise<AudioAssetMeta[]> {
  const dir = await assetsDirectory();
  const out: AudioAssetMeta[] = [];
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
 * Deletes a stored asset (payload + sidecar). Deleting an id that is not
 * stored is a no-op, so callers can treat deletion as idempotent.
 *
 * @param id Asset id.
 */
export async function deleteAsset(id: string): Promise<void> {
  validateAssetId(id);
  const dir = await assetsDirectory();
  audioCache.delete(id);
  for (const fileName of [id + PCM_EXTENSION, id + META_EXTENSION]) {
    try {
      await dir.removeEntry(fileName);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }
}
