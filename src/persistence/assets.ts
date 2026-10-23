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
 * project archive (see src/project/document-schema.ts).
 */

import { FNV1A_OFFSET_BASIS, FNV1A_SECOND_SEED, fnv1a32Bytes } from '@/lib/fnv1a';
import {
  bytesEqual,
  isNotFoundError,
  MEDIA_ID_PATTERN,
  OPFS_IO_CHUNK_BYTES,
  removeOptionalFile,
  writeOpfsFile,
} from './fs-utils';
import { withPersistenceMutationLock } from './mutation-lock';
import { opfsDirectory } from './opfs';
import {
  BYTES_PER_SAMPLE,
  MAX_AUDIO_CHANNELS,
  MAX_AUDIO_SAMPLE_BYTES,
  MAX_AUDIO_SAMPLE_RATE,
  MAX_AUDIO_SAMPLES,
} from './resource-limits';

/** Directory under the OPFS root that holds the audio assets. */
const ASSETS_DIR = 'assets';

/** File extension of the raw interleaved float32 PCM payload. */
const PCM_EXTENSION = '.pcm';

/** File extension of the JSON metadata sidecar. */
const META_EXTENSION = '.json';

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
  /** Confidence of the detected tempo in [0, 1], when reported. */
  bpmConfidence?: number;
  /** Detected musical key (display string, e.g. "Am"). */
  key?: string;
  /** Confidence of the detected key in [0, 1], when reported. */
  keyConfidence?: number;
  /** Detected time signature, e.g. "4/4". */
  timeSignature?: string;
  /** Confidence of the detected time signature in [0, 1], when reported. */
  timeSignatureConfidence?: number;
  /** Coarse groove label from rhythm analysis, when reported. */
  grooveType?: string;
  /** Rhythmic syncopation estimate in [0, 1], when reported. */
  syncopation?: number;
  /** Pattern regularity estimate in [0, 1], when reported. */
  patternRegularity?: number;
  /** Tempo stability estimate in [0, 1], when reported. */
  tempoStability?: number;
  /** Dynamics dynamic range in dB, when reported. */
  dynamicRangeDb?: number;
  /** Peak level in dBFS, when reported. */
  peakDb?: number;
  /** RMS level in dBFS, when reported. */
  rmsDb?: number;
  /** Crest factor, when reported. */
  crestFactor?: number;
  /** Loudness range in dB, when reported. */
  loudnessRangeDb?: number;
  /** Compression classifier from dynamics analysis, when reported. */
  isCompressed?: boolean;
  /** Timbre brightness estimate, when reported. */
  brightness?: number;
  /** Timbre warmth estimate, when reported. */
  warmth?: number;
  /** Timbre density estimate, when reported. */
  density?: number;
  /** Timbre roughness estimate, when reported. */
  roughness?: number;
  /** Timbre complexity estimate, when reported. */
  complexity?: number;
  /** Coarse form label from unified analysis, when reported. */
  form?: string;
  /** Integrated loudness in LUFS (EBU R128). */
  lufs?: number;
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

/** User-facing metadata kept separately from immutable PCM content fields. */
export interface AudioAssetAlias {
  name: string;
  tags?: AudioAssetTags;
}

interface StoredAudioAssetRecord {
  schemaVersion: 2;
  content: {
    id: string;
    sampleRate: number;
    numChannels: number;
    numFrames: number;
  };
  aliases: AudioAssetAlias[];
}

/** Result used by save→project transactions to roll back newly published content. */
export interface SavedAudioAsset {
  meta: AudioAssetMeta;
  /** True only when this call published a new PCM payload. */
  created: boolean;
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
  /** Called synchronously after content id resolution and before OPFS awaits. */
  onIdResolved?: (id: string) => void;
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

/** Default retained PCM budget for the decoded-audio LRU (256 MiB). */
export const DEFAULT_AUDIO_ASSET_CACHE_BYTE_BUDGET = 256 * 1024 * 1024;

let audioCacheByteBudget = DEFAULT_AUDIO_ASSET_CACHE_BYTE_BUDGET;
let audioCacheBytes = 0;

function loadedAssetBytes(asset: LoadedAudioAsset): number {
  return asset.channels.reduce((sum, channel) => sum + channel.byteLength, 0);
}

function removeCachedAsset(id: string): void {
  const existing = audioCache.get(id);
  if (!existing) return;
  audioCache.delete(id);
  audioCacheBytes -= loadedAssetBytes(existing);
}

function cachedAsset(id: string): LoadedAudioAsset | undefined {
  const cached = audioCache.get(id);
  if (!cached) return undefined;
  // Map insertion order is the LRU order. Returned buffers remain alive for
  // current consumers even if a later insertion evicts this cache reference.
  audioCache.delete(id);
  audioCache.set(id, cached);
  return cached;
}

function cacheAsset(id: string, asset: LoadedAudioAsset): void {
  removeCachedAsset(id);
  const bytes = loadedAssetBytes(asset);
  if (bytes > audioCacheByteBudget) return;
  while (audioCache.size > 0 && audioCacheBytes + bytes > audioCacheByteBudget) {
    const oldest = audioCache.keys().next().value;
    if (oldest === undefined) break;
    removeCachedAsset(oldest);
  }
  audioCache.set(id, asset);
  audioCacheBytes += bytes;
}

/**
 * Warms the cache after a save, deinterleaving only when the result is kept.
 * Unchanged content never re-deinterleaves: a cached entry just takes the
 * latest metadata, and an uncached one stays uncached.
 */
function cacheSavedAsset(
  meta: AudioAssetMeta,
  interleaved: Float32Array,
  numChannels: number,
  created: boolean,
): void {
  const existing = audioCache.get(meta.id);
  if (!created && !existing) return;
  if (interleaved.byteLength > audioCacheByteBudget) {
    removeCachedAsset(meta.id);
    return;
  }
  const channels =
    !created && existing ? existing.channels : deinterleaveChannels(interleaved, numChannels);
  cacheAsset(meta.id, { meta, channels });
}

/** Current decoded-audio LRU usage for diagnostics and memory tests. */
export function audioAssetCacheStats(): {
  entries: number;
  bytes: number;
  budgetBytes: number;
  /** Least-recently-used to most-recently-used ids. */
  ids: string[];
} {
  return {
    entries: audioCache.size,
    bytes: audioCacheBytes,
    budgetBytes: audioCacheByteBudget,
    ids: [...audioCache.keys()],
  };
}

/** Sets the decoded-audio cache byte budget and evicts least-recently-used entries. */
export function configureAudioAssetCacheByteBudget(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError(`Audio cache byte budget must be finite and >= 0, got ${bytes}`);
  }
  audioCacheByteBudget = Math.floor(bytes);
  while (audioCacheBytes > audioCacheByteBudget && audioCache.size > 0) {
    const oldest = audioCache.keys().next().value;
    if (oldest === undefined) break;
    removeCachedAsset(oldest);
  }
}

const NUMERIC_TAG_KEYS = [
  'bpm',
  'bpmConfidence',
  'keyConfidence',
  'timeSignatureConfidence',
  'syncopation',
  'patternRegularity',
  'tempoStability',
  'dynamicRangeDb',
  'peakDb',
  'rmsDb',
  'crestFactor',
  'loudnessRangeDb',
  'brightness',
  'warmth',
  'density',
  'roughness',
  'complexity',
  'lufs',
] as const satisfies ReadonlyArray<keyof AudioAssetTags>;

const STRING_TAG_KEYS = [
  'key',
  'timeSignature',
  'grooveType',
  'form',
] as const satisfies ReadonlyArray<keyof AudioAssetTags>;

function sanitizeAudioAssetTags(raw: AudioAssetTags | undefined): AudioAssetTags | undefined {
  if (!raw) return undefined;
  const tags: AudioAssetTags = {};
  for (const key of NUMERIC_TAG_KEYS) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (key !== 'bpm' || value > 0) tags[key] = value;
    }
  }
  for (const key of STRING_TAG_KEYS) {
    const value = raw[key];
    if (typeof value === 'string' && value.length > 0) tags[key] = value;
  }
  if (typeof raw.isCompressed === 'boolean') tags.isCompressed = raw.isCompressed;
  return Object.keys(tags).length > 0 ? tags : undefined;
}

/** Drops all cached asset audio (tests, memory pressure handling). */
export function clearAudioAssetCache(): void {
  audioCache.clear();
  audioCacheBytes = 0;
}

/** Throws {@link InvalidAssetError} unless the id is a safe file base name. */
function validateAssetId(id: string): string {
  if (!MEDIA_ID_PATTERN.test(id)) {
    throw new InvalidAssetError(`Invalid asset id: "${id}"`);
  }
  return id;
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
  const a = fnv1a32Bytes(body, fnv1a32Bytes(header, FNV1A_OFFSET_BASIS));
  const b = fnv1a32Bytes(body, fnv1a32Bytes(header, FNV1A_SECOND_SEED));
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
 * Produces an owned byte representation of planar PCM suitable for archive
 * entries and byte-for-byte conflict checks.
 */
export function interleavedPcmBytes(channels: ReadonlyArray<Float32Array>): Uint8Array {
  const interleaved = interleaveChannels(channels);
  return new Uint8Array(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength).slice();
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
  if (!Number.isInteger(numChannels) || numChannels < 1 || numChannels > MAX_AUDIO_CHANNELS) {
    throw new InvalidAssetError(`numChannels must be a positive integer, got ${numChannels}`);
  }
  if (interleaved.length === 0 || interleaved.length > MAX_AUDIO_SAMPLES) {
    throw new InvalidAssetError(
      `Audio sample count must be between 1 and ${MAX_AUDIO_SAMPLES}, got ${interleaved.length}`,
    );
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

/** Resolves (creating on demand) the "assets/" directory handle. */
function assetsDirectory(): Promise<FileSystemDirectoryHandle> {
  return opfsDirectory(ASSETS_DIR);
}

function validatedContentMeta(
  value: Partial<AudioAssetMeta>,
  id: string,
  alias: AudioAssetAlias,
): AudioAssetMeta {
  if (
    value.id !== id ||
    typeof value.sampleRate !== 'number' ||
    !Number.isFinite(value.sampleRate) ||
    value.sampleRate <= 0 ||
    value.sampleRate > MAX_AUDIO_SAMPLE_RATE ||
    !Number.isInteger(value.numChannels) ||
    (value.numChannels as number) < 1 ||
    (value.numChannels as number) > MAX_AUDIO_CHANNELS ||
    !Number.isInteger(value.numFrames) ||
    (value.numFrames as number) < 1 ||
    !Number.isSafeInteger((value.numFrames as number) * (value.numChannels as number)) ||
    (value.numFrames as number) * (value.numChannels as number) > MAX_AUDIO_SAMPLES
  ) {
    throw new InvalidAssetError(`Asset "${id}": malformed metadata sidecar`);
  }
  return {
    id,
    name: alias.name,
    sampleRate: value.sampleRate,
    numChannels: value.numChannels as number,
    numFrames: value.numFrames as number,
    ...(alias.tags ? { tags: { ...alias.tags } } : {}),
  };
}

function validateAlias(value: unknown, id: string): AudioAssetAlias {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidAssetError(`Asset "${id}": malformed metadata alias`);
  }
  const raw = value as Partial<AudioAssetAlias>;
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new InvalidAssetError(`Asset "${id}": malformed metadata alias`);
  }
  const tags =
    typeof raw.tags === 'object' && raw.tags !== null
      ? sanitizeAudioAssetTags(raw.tags as AudioAssetTags)
      : undefined;
  return { name: raw.name, ...(tags ? { tags } : {}) };
}

function recordFromMeta(meta: AudioAssetMeta, aliases: AudioAssetAlias[]): StoredAudioAssetRecord {
  return {
    schemaVersion: 2,
    content: {
      id: meta.id,
      sampleRate: meta.sampleRate,
      numChannels: meta.numChannels,
      numFrames: meta.numFrames,
    },
    aliases: aliases.map((alias) => ({
      name: alias.name,
      ...(alias.tags ? { tags: { ...alias.tags } } : {}),
    })),
  };
}

function decodeStoredRecord(
  value: unknown,
  id: string,
): { meta: AudioAssetMeta; aliases: AudioAssetAlias[]; record: StoredAudioAssetRecord } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidAssetError(`Asset "${id}": metadata sidecar is not a JSON object`);
  }
  const raw = value as Partial<StoredAudioAssetRecord> & Partial<AudioAssetMeta>;
  if (raw.schemaVersion === 2) {
    if (
      typeof raw.content !== 'object' ||
      raw.content === null ||
      !Array.isArray(raw.aliases) ||
      raw.aliases.length === 0
    ) {
      throw new InvalidAssetError(`Asset "${id}": malformed metadata sidecar`);
    }
    const aliases = raw.aliases.map((alias) => validateAlias(alias, id));
    const meta = validatedContentMeta(
      raw.content as Partial<AudioAssetMeta>,
      id,
      aliases[aliases.length - 1],
    );
    return { meta, aliases, record: recordFromMeta(meta, aliases) };
  }
  // Legacy v1 sidecars stored the mutable display metadata beside content.
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new InvalidAssetError(`Asset "${id}": malformed metadata sidecar`);
  }
  const alias = validateAlias({ name: raw.name, tags: raw.tags }, id);
  const meta = validatedContentMeta(raw, id, alias);
  return { meta, aliases: [alias], record: recordFromMeta(meta, [alias]) };
}

/** Validates a parsed sidecar object into an {@link AudioAssetMeta}. */
function validateMeta(value: unknown, id: string): AudioAssetMeta {
  return decodeStoredRecord(value, id).meta;
}

function aliasesEqual(a: AudioAssetAlias, b: AudioAssetAlias): boolean {
  return a.name === b.name && JSON.stringify(a.tags ?? {}) === JSON.stringify(b.tags ?? {});
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

/**
 * Compares an existing PCM file without materializing its whole contents.
 * Returns null when no payload exists, otherwise whether every chunk matches.
 */
async function pcmFileMatches(
  dir: FileSystemDirectoryHandle,
  fileName: string,
  expected: Uint8Array,
): Promise<boolean | null> {
  try {
    const handle = await dir.getFileHandle(fileName);
    const file = await handle.getFile();
    if (file.size !== expected.byteLength) return false;
    if (typeof file.slice !== 'function') {
      // Minimal OPFS mocks and a few legacy File implementations omit slice.
      return bytesEqual(new Uint8Array(await file.arrayBuffer()), expected);
    }
    for (let offset = 0; offset < expected.byteLength; offset += OPFS_IO_CHUNK_BYTES) {
      const end = Math.min(expected.byteLength, offset + OPFS_IO_CHUNK_BYTES);
      const actual = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      if (!bytesEqual(actual, expected.subarray(offset, end))) return false;
    }
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
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
export async function saveAssetWithStatusUnlocked(
  input: SaveAssetInput,
  audio: Float32Array | ReadonlyArray<Float32Array>,
): Promise<SavedAudioAsset> {
  if (typeof input.name !== 'string' || input.name.length === 0) {
    throw new InvalidAssetError('Asset name must not be empty');
  }
  if (!Number.isFinite(input.sampleRate) || input.sampleRate <= 0) {
    throw new InvalidAssetError(`Asset sampleRate must be finite and > 0, got ${input.sampleRate}`);
  }
  if (input.sampleRate > MAX_AUDIO_SAMPLE_RATE) {
    throw new InvalidAssetError(
      `Asset sampleRate must not exceed ${MAX_AUDIO_SAMPLE_RATE}, got ${input.sampleRate}`,
    );
  }
  let interleaved: Float32Array;
  let numChannels: number;
  if (audio instanceof Float32Array) {
    numChannels = input.numChannels ?? 1;
    if (!Number.isInteger(numChannels) || numChannels < 1 || numChannels > MAX_AUDIO_CHANNELS) {
      throw new InvalidAssetError(`numChannels must be a positive integer, got ${numChannels}`);
    }
    if (audio.length % numChannels !== 0) {
      throw new InvalidAssetError(
        `Interleaved length ${audio.length} is not divisible by ${numChannels} channels`,
      );
    }
    if (audio.length === 0 || audio.length > MAX_AUDIO_SAMPLES) {
      throw new InvalidAssetError(
        `Audio sample count must be between 1 and ${MAX_AUDIO_SAMPLES}, got ${audio.length}`,
      );
    }
    interleaved = audio;
  } else {
    if (audio.length > MAX_AUDIO_CHANNELS) {
      throw new InvalidAssetError(`Audio must not exceed ${MAX_AUDIO_CHANNELS} channels`);
    }
    const frames = audio[0]?.length ?? 0;
    const totalSamples = frames * audio.length;
    if (frames < 1 || !Number.isSafeInteger(totalSamples) || totalSamples > MAX_AUDIO_SAMPLES) {
      throw new InvalidAssetError(
        `Audio sample count must be between 1 and ${MAX_AUDIO_SAMPLES}, got ${totalSamples}`,
      );
    }
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
  input.onIdResolved?.(id);
  const requestedMeta: AudioAssetMeta = {
    id,
    name: input.name,
    sampleRate: input.sampleRate,
    numChannels,
    numFrames,
  };
  const tags = sanitizeAudioAssetTags(input.tags);
  if (tags) requestedMeta.tags = tags;
  const requestedAlias: AudioAssetAlias = {
    name: input.name,
    ...(tags ? { tags: { ...tags } } : {}),
  };

  const dir = await assetsDirectory();
  const pcmBytes = new Uint8Array(
    interleaved.buffer,
    interleaved.byteOffset,
    interleaved.byteLength,
  );
  let existingPcmMatches = await pcmFileMatches(dir, id + PCM_EXTENSION, pcmBytes);
  const existingSidecar = await readOptionalFile(dir, id + META_EXTENSION);
  if (existingPcmMatches === false) {
    if (existingSidecar !== null) {
      throw new InvalidAssetError(`Asset "${id}": immutable PCM content collision`);
    }
    // A sidecarless payload is unpublished. It may be a truncated write left
    // by a quota failure, so discard it before retrying the same content.
    await removeOptionalFile(dir, id + PCM_EXTENSION);
    existingPcmMatches = null;
  }
  if (existingPcmMatches === null && existingSidecar !== null) {
    throw new InvalidAssetError(`Asset "${id}": metadata exists without its PCM payload`);
  }

  let aliases = [requestedAlias];
  if (existingSidecar !== null) {
    let stored: ReturnType<typeof decodeStoredRecord>;
    try {
      stored = decodeStoredRecord(JSON.parse(new TextDecoder().decode(existingSidecar)), id);
    } catch (error) {
      if (error instanceof InvalidAssetError) throw error;
      throw new InvalidAssetError(`Asset "${id}": metadata sidecar is not valid JSON`);
    }
    if (
      stored.meta.sampleRate !== requestedMeta.sampleRate ||
      stored.meta.numChannels !== requestedMeta.numChannels ||
      stored.meta.numFrames !== requestedMeta.numFrames
    ) {
      throw new InvalidAssetError(`Asset "${id}": immutable content metadata collision`);
    }
    aliases = [...stored.aliases];
    if (!aliases.some((alias) => aliasesEqual(alias, requestedAlias))) aliases.push(requestedAlias);
  }
  const record = recordFromMeta(requestedMeta, aliases);
  const latestMeta = validatedContentMeta(record.content, id, aliases[aliases.length - 1]);
  const created = existingPcmMatches === null;
  const sidecarCreated = existingSidecar === null;
  if (created) {
    try {
      await writeOpfsFile(dir, id + PCM_EXTENSION, pcmBytes);
    } catch (error) {
      // createWritable() may create an empty/truncated entry before write()
      // rejects. Never leave that unpublished payload to become a collision.
      await removeOptionalFile(dir, id + PCM_EXTENSION);
      throw error;
    }
  }
  try {
    await writeOpfsFile(dir, id + META_EXTENSION, new TextEncoder().encode(JSON.stringify(record)));
  } catch (error) {
    // A sidecar that did not exist before this attempt is itself unpublished
    // when its write fails. Remove it along with any newly created PCM so a
    // retry cannot parse a truncated JSON file or collide with partial data.
    if (sidecarCreated) await removeOptionalFile(dir, id + META_EXTENSION);
    if (created) await removeOptionalFile(dir, id + PCM_EXTENSION);
    throw error;
  }
  cacheSavedAsset(latestMeta, interleaved, numChannels, created);
  return { meta: latestMeta, created };
}

export function saveAssetWithStatus(
  input: SaveAssetInput,
  audio: Float32Array | ReadonlyArray<Float32Array>,
): Promise<SavedAudioAsset> {
  return withPersistenceMutationLock(() => saveAssetWithStatusUnlocked(input, audio));
}

export async function saveAsset(
  input: SaveAssetInput,
  audio: Float32Array | ReadonlyArray<Float32Array>,
): Promise<AudioAssetMeta> {
  return (await saveAssetWithStatus(input, audio)).meta;
}

/**
 * Reads an asset's metadata sidecar.
 *
 * @param id Asset id.
 * @returns The stored metadata.
 * @throws AssetNotFoundError when no such asset is stored.
 */
export async function loadAssetMeta(
  id: string,
  options: { cache?: boolean } = {},
): Promise<AudioAssetMeta> {
  validateAssetId(id);
  if (options.cache !== false) {
    const cached = cachedAsset(id);
    if (cached) return cached.meta;
  }
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
 * Validates that an asset's PCM payload exists and matches its sidecar without
 * reading or decoding the PCM bytes. Use this before expensive offline work so
 * a missing/truncated payload cannot silently become rendered silence.
 */
export async function validateAssetPayload(id: string): Promise<AudioAssetMeta> {
  validateAssetId(id);
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
  const expectedBytes = meta.numFrames * meta.numChannels * BYTES_PER_SAMPLE;
  if (expectedBytes > MAX_AUDIO_SAMPLE_BYTES || file.size > MAX_AUDIO_SAMPLE_BYTES) {
    throw new InvalidAssetError(`Asset "${id}": PCM payload exceeds the audio resource limit`);
  }
  if (file.size !== expectedBytes) {
    throw new InvalidAssetError(
      `Asset "${id}": PCM payload is ${file.size} bytes, expected ${expectedBytes}`,
    );
  }
  return meta;
}

/** Lists every preserved user-facing alias for one immutable content id. */
export async function listAssetAliases(id: string): Promise<AudioAssetAlias[]> {
  validateAssetId(id);
  const dir = await assetsDirectory();
  const bytes = await readOptionalFile(dir, id + META_EXTENSION);
  if (bytes === null) throw new AssetNotFoundError(id);
  try {
    return decodeStoredRecord(JSON.parse(new TextDecoder().decode(bytes)), id).aliases.map(
      (alias) => ({ name: alias.name, ...(alias.tags ? { tags: { ...alias.tags } } : {}) }),
    );
  } catch (error) {
    if (error instanceof InvalidAssetError) throw error;
    throw new InvalidAssetError(`Asset "${id}": metadata sidecar is not valid JSON`);
  }
}

/**
 * Reads an asset's metadata and PCM payload, deinterleaved to planar channel
 * buffers. Results are cached in memory; treat the returned buffers as
 * immutable (copy before mutating).
 *
 * @param id Asset id.
 * @param options `cache: false` bypasses the decoded-audio LRU entirely (no
 *   read bump, no insert). Use it for bulk library walks (e.g. backup) so they
 *   do not evict the assets active playback is using.
 * @returns Metadata plus planar channel buffers.
 * @throws AssetNotFoundError when no such asset is stored.
 * @throws InvalidAssetError when the PCM size disagrees with the sidecar.
 */
export async function loadAsset(
  id: string,
  options: { cache?: boolean } = {},
): Promise<LoadedAudioAsset> {
  validateAssetId(id);
  if (options.cache !== false) {
    const cached = cachedAsset(id);
    if (cached) return cached;
  }
  const meta = await loadAssetMeta(id, options);
  const bytes = await readValidatedPcm(id, meta);
  const channels = deinterleaveChannels(new Float32Array(bytes), meta.numChannels);
  const loaded: LoadedAudioAsset = { meta, channels };
  if (options.cache !== false) cacheAsset(id, loaded);
  return loaded;
}

/** Reads an asset's PCM payload and checks it against the sidecar's frame and channel counts. */
async function readValidatedPcm(id: string, meta: AudioAssetMeta): Promise<ArrayBuffer> {
  const dir = await assetsDirectory();
  let file: File;
  try {
    const handle = await dir.getFileHandle(id + PCM_EXTENSION);
    file = await handle.getFile();
  } catch (error) {
    if (isNotFoundError(error)) throw new AssetNotFoundError(id);
    throw error;
  }
  const expectedBytes = meta.numFrames * meta.numChannels * BYTES_PER_SAMPLE;
  if (expectedBytes > MAX_AUDIO_SAMPLE_BYTES || file.size > MAX_AUDIO_SAMPLE_BYTES) {
    throw new InvalidAssetError(`Asset "${id}": PCM payload exceeds the audio resource limit`);
  }
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== expectedBytes) {
    throw new InvalidAssetError(
      `Asset "${id}": PCM payload is ${bytes.byteLength} bytes, expected ${expectedBytes}`,
    );
  }
  return bytes;
}

/**
 * Reads an asset's metadata and its raw interleaved little-endian float32 PCM
 * bytes, skipping the planar decode and the decoded-audio LRU. Use it where the
 * bytes are only compared or serialized (backup, bundle export, restore checks).
 *
 * @param id Asset id.
 * @returns Metadata plus an owned PCM byte buffer.
 * @throws AssetNotFoundError when no such asset is stored.
 * @throws InvalidAssetError when the PCM size disagrees with the sidecar.
 */
export async function readAssetPcmBytes(
  id: string,
): Promise<{ meta: AudioAssetMeta; pcm: Uint8Array }> {
  validateAssetId(id);
  const meta = await loadAssetMeta(id, { cache: false });
  return { meta, pcm: new Uint8Array(await readValidatedPcm(id, meta)) };
}

/**
 * Reads a frame range of a stored asset's PCM without decoding the rest of it.
 *
 * The payload layout is raw interleaved little-endian float32 with no header,
 * so a byte range maps straight onto a frame range. This is the read an offline
 * render uses to page a long clip through the engine instead of holding its
 * whole PCM; it deliberately bypasses the decoded-audio LRU, which exists for
 * repeated whole-asset use.
 *
 * @param id Asset id.
 * @param startFrame First frame to read (>= 0).
 * @param frameCount Frames to read (>= 1).
 * @param numChannels Channel count of the stored payload.
 * @returns One planar buffer per channel, `frameCount` frames long.
 * @throws AssetNotFoundError when no payload is stored.
 * @throws InvalidAssetError when the range runs past the stored payload.
 */
export async function readAssetFrames(
  id: string,
  startFrame: number,
  frameCount: number,
  numChannels: number,
): Promise<Float32Array[]> {
  validateAssetId(id);
  if (!Number.isInteger(startFrame) || startFrame < 0) {
    throw new InvalidAssetError(`Asset "${id}": start frame must be a non-negative integer`);
  }
  if (!Number.isInteger(frameCount) || frameCount < 1) {
    throw new InvalidAssetError(`Asset "${id}": frame count must be a positive integer`);
  }
  if (!Number.isInteger(numChannels) || numChannels < 1 || numChannels > MAX_AUDIO_CHANNELS) {
    throw new InvalidAssetError(`Asset "${id}": invalid channel count ${numChannels}`);
  }
  const dir = await assetsDirectory();
  let file: File;
  try {
    const handle = await dir.getFileHandle(id + PCM_EXTENSION);
    file = await handle.getFile();
  } catch (error) {
    if (isNotFoundError(error)) throw new AssetNotFoundError(id);
    throw error;
  }
  const frameBytes = numChannels * BYTES_PER_SAMPLE;
  const from = startFrame * frameBytes;
  const to = from + frameCount * frameBytes;
  if (to > file.size) {
    throw new InvalidAssetError(
      `Asset "${id}": frames ${startFrame}..${startFrame + frameCount} run past the stored payload`,
    );
  }
  const bytes =
    typeof file.slice === 'function'
      ? new Uint8Array(await file.slice(from, to).arrayBuffer())
      : // Minimal OPFS mocks and a few legacy File implementations omit slice.
        new Uint8Array(await file.arrayBuffer()).subarray(from, to);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < numChannels; channel += 1) {
    const out = new Float32Array(frameCount);
    for (let frame = 0; frame < frameCount; frame += 1) {
      out[frame] = view.getFloat32((frame * numChannels + channel) * BYTES_PER_SAMPLE, true);
    }
    channels.push(out);
  }
  return channels;
}

/**
 * Lists the stored assets (their metadata sidecars), sorted by name then id.
 * Files with malformed sidecars are skipped.
 */
export async function listAssets(): Promise<AudioAssetMeta[]> {
  const dir = await assetsDirectory();
  const entries: Array<[string, FileSystemFileHandle]> = [];
  for await (const [entryName, handle] of dir.entries()) {
    if (handle.kind === 'file' && entryName.endsWith(META_EXTENSION))
      entries.push([entryName, handle]);
  }
  const read = await Promise.all(
    entries.map(async ([entryName, handle]): Promise<AudioAssetMeta | null> => {
      const id = entryName.slice(0, -META_EXTENSION.length);
      try {
        const file = await handle.getFile();
        const parsed = JSON.parse(new TextDecoder().decode(await file.arrayBuffer()));
        return validateMeta(parsed, id);
      } catch {
        // Skip unreadable or malformed sidecars; the listing stays usable.
        return null;
      }
    }),
  );
  const out = read.filter((meta): meta is AudioAssetMeta => meta !== null);
  out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return out;
}

/** One raw PCM payload file stored under assets/. */
export interface AudioAssetPayloadInfo {
  /** Asset id derived from `<id>.pcm`. */
  id: string;
  /** Payload byte length. */
  byteLength: number;
}

/**
 * Lists stored raw PCM payloads, including files whose metadata sidecar is
 * missing. Malformed filenames are skipped.
 */
export async function listAssetPayloads(): Promise<AudioAssetPayloadInfo[]> {
  const dir = await assetsDirectory();
  const entries: Array<[string, FileSystemFileHandle]> = [];
  for await (const [entryName, handle] of dir.entries()) {
    if (handle.kind === 'file' && entryName.endsWith(PCM_EXTENSION))
      entries.push([entryName, handle]);
  }
  const read = await Promise.all(
    entries.map(async ([entryName, handle]): Promise<AudioAssetPayloadInfo | null> => {
      const id = entryName.slice(0, -PCM_EXTENSION.length);
      try {
        validateAssetId(id);
        const file = await handle.getFile();
        return { id, byteLength: file.size };
      } catch {
        // Skip invalid ids or unreadable files; GC/listing should remain usable.
        return null;
      }
    }),
  );
  const out = read.filter((info): info is AudioAssetPayloadInfo => info !== null);
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Deletes a stored asset (payload + sidecar). Deleting an id that is not
 * stored is a no-op, so callers can treat deletion as idempotent.
 *
 * @param id Asset id.
 */
export async function deleteAssetUnlocked(id: string): Promise<void> {
  validateAssetId(id);
  const dir = await assetsDirectory();
  removeCachedAsset(id);
  // Remove the metadata sidecar before its payload: listing and GC key off the
  // PCM payload, so an interrupted deletion that leaves the payload behind stays
  // visible and collectable, whereas an orphaned sidecar (payload gone first)
  // would be invisible to both and linger forever.
  for (const fileName of [id + META_EXTENSION, id + PCM_EXTENSION]) {
    try {
      await dir.removeEntry(fileName);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }
}

export function deleteAsset(id: string): Promise<void> {
  return withPersistenceMutationLock(() => deleteAssetUnlocked(id));
}
