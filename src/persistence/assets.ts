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

import { cacheAsset, cachedAsset, cacheSavedAsset, removeCachedAsset } from './asset-cache';
import { AssetNotFoundError, InvalidAssetError } from './asset-errors';
import { computeAssetId, deinterleaveChannels, interleaveChannels } from './asset-pcm';
import {
  aliasesEqual,
  decodeStoredRecord,
  recordFromMeta,
  sanitizeAudioAssetTags,
  validatedContentMeta,
  validateMeta,
} from './asset-sidecar';
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

export {
  audioAssetCacheStats,
  clearAudioAssetCache,
  configureAudioAssetCacheByteBudget,
  DEFAULT_AUDIO_ASSET_CACHE_BYTE_BUDGET,
} from './asset-cache';
export { AssetNotFoundError, InvalidAssetError } from './asset-errors';
export {
  computeAssetId,
  deinterleaveChannels,
  interleaveChannels,
  interleavedPcmBytes,
} from './asset-pcm';

/** Directory under the OPFS root that holds the audio assets. */
const ASSETS_DIR = 'assets';

/** File extension of the raw interleaved float32 PCM payload. */
const PCM_EXTENSION = '.pcm';

/** File extension of the JSON metadata sidecar. */
const META_EXTENSION = '.json';

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

/** Throws {@link InvalidAssetError} unless the id is a safe file base name. */
function validateAssetId(id: string): string {
  if (!MEDIA_ID_PATTERN.test(id)) {
    throw new InvalidAssetError(`Invalid asset id: "${id}"`);
  }
  return id;
}

/** Resolves (creating on demand) the "assets/" directory handle. */
function assetsDirectory(): Promise<FileSystemDirectoryHandle> {
  return opfsDirectory(ASSETS_DIR);
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
