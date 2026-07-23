/**
 * Bridges the OPFS media stores (audio assets, SoundFonts) and the .szd codec
 * so disk export/import carries a project's media with it.
 *
 * OPFS save slots leave media out-of-band (the document only references ids),
 * which is fine on one machine. A disk export shared with someone else, or an
 * OPFS-less restore, has no shared store to resolve those ids against — so the
 * referenced assets and fonts are gathered into the archive on export and
 * written back into the stores on import.
 */

import { collectReferencedAudioAssetIds } from '@/project/asset-references';
import {
  computeFontId,
  deleteFontUnlocked,
  FontNotFoundError,
  loadFont,
  loadFontMeta,
  type SoundFontMeta,
  saveFontWithStatusUnlocked,
} from '@/project/fonts';
import {
  createMediaCompletenessReport,
  type MediaCompletenessIssue,
  type MediaCompletenessReport,
  mediaFailureIssues,
} from '@/project/media-completeness';
import type { ProjectDocument } from '@/project/serialization';
import {
  AssetNotFoundError,
  type AudioAssetMeta,
  computeAssetId,
  deleteAssetUnlocked,
  interleaveChannels,
  loadAsset,
  saveAssetWithStatusUnlocked,
} from './assets';
import { withPersistenceMutationLock } from './mutation-lock';
import {
  MAX_AUDIO_CHANNELS,
  MAX_AUDIO_SAMPLE_BYTES,
  MAX_AUDIO_SAMPLE_RATE,
  MAX_AUDIO_SAMPLES,
} from './resource-limits';
import type { SzdMediaBundle } from './szd';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Collects every audio-asset id the document references (clips, takes, freezes). */
export function collectReferencedAssetIds(doc: ProjectDocument): Set<string> {
  return collectReferencedAudioAssetIds(
    doc.tracks.flatMap((track) => track.clips),
    doc.tracks,
  );
}

/** Collects every SoundFont id the document references (SF2 instruments). */
export function collectReferencedFontIds(doc: ProjectDocument): Set<string> {
  const ids = new Set<string>();
  for (const track of doc.tracks) {
    if (track.instrument?.kind === 'sf2' && track.instrument.fontId) {
      ids.add(track.instrument.fontId);
    }
  }
  return ids;
}

/** Raw interleaved-PCM bytes view of planar channels (a fresh copy). */
function pcmBytes(channels: ReadonlyArray<Float32Array>): Uint8Array {
  const interleaved = interleaveChannels(channels);
  return new Uint8Array(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength).slice();
}

/**
 * Gathers the OPFS media referenced by a document into a bundle for
 * {@link encodeSzd}. Ids that are not stored (or unreadable) are skipped, so a
 * partial project still exports rather than failing outright.
 *
 * @param doc The document being exported.
 * @returns The referenced assets and fonts that could be read.
 */
export async function gatherProjectBundleWithReport(
  doc: ProjectDocument,
): Promise<{ bundle: SzdMediaBundle; report: MediaCompletenessReport }> {
  const issues: MediaCompletenessIssue[] = [];
  const assets = [];
  for (const id of collectReferencedAssetIds(doc)) {
    try {
      const loaded = await loadAsset(id);
      assets.push({
        id,
        meta: textEncoder.encode(JSON.stringify(loaded.meta)),
        pcm: pcmBytes(loaded.channels),
      });
    } catch (error) {
      issues.push(...mediaFailureIssues(doc, 'audio-asset', id, 'unreadable', error));
    }
  }
  const fonts = [];
  for (const id of collectReferencedFontIds(doc)) {
    try {
      const [data, meta] = await Promise.all([loadFont(id), loadFontMeta(id)]);
      fonts.push({ id, meta: textEncoder.encode(JSON.stringify(meta)), sf2: data });
    } catch (error) {
      issues.push(...mediaFailureIssues(doc, 'soundfont', id, 'unreadable', error));
    }
  }
  return { bundle: { assets, fonts }, report: createMediaCompletenessReport(issues) };
}

/** Backward-compatible bundle-only view; portable UI paths use the report variant. */
export async function gatherProjectBundle(doc: ProjectDocument): Promise<SzdMediaBundle> {
  return (await gatherProjectBundleWithReport(doc)).bundle;
}

/** Reconstructs a Float32Array from interleaved-PCM bytes (alignment-safe). */
function floatsFromPcm(bytes: Uint8Array): Float32Array {
  const copy = bytes.slice();
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
}

const CONTENT_ID_PATTERN = /^[0-9a-f]{16}$/i;

/** A referenced archive entry conflicts with an existing shared media id. */
export class MediaRestoreConflictError extends Error {
  constructor(kind: 'asset' | 'font', id: string) {
    super(`Bundled ${kind} "${id}" conflicts with existing stored content`);
    this.name = 'MediaRestoreConflictError';
  }
}

/** Validated audio entry ready for conflict preflight and commit. */
export interface PreparedAssetRestore {
  id: string;
  meta: AudioAssetMeta;
  audio: Float32Array;
}

/** Validated SoundFont entry ready for conflict preflight and commit. */
export interface PreparedFontRestore {
  id: string;
  meta: SoundFontMeta;
  data: Uint8Array;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

/** Parses and validates one bundled audio pair without touching storage. */
export function prepareAssetRestore(entry: SzdMediaBundle['assets'][number]): PreparedAssetRestore {
  if (
    entry.pcm.byteLength === 0 ||
    entry.pcm.byteLength > MAX_AUDIO_SAMPLE_BYTES ||
    entry.pcm.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0
  ) {
    throw new Error(`Bundled asset "${entry.id}" has an invalid PCM payload size`);
  }
  const parsed = JSON.parse(textDecoder.decode(entry.meta)) as Partial<AudioAssetMeta>;
  if (
    parsed.id !== entry.id ||
    typeof parsed.name !== 'string' ||
    parsed.name.length === 0 ||
    !Number.isFinite(parsed.sampleRate) ||
    (parsed.sampleRate as number) <= 0 ||
    (parsed.sampleRate as number) > MAX_AUDIO_SAMPLE_RATE ||
    !Number.isInteger(parsed.numChannels) ||
    (parsed.numChannels as number) < 1 ||
    (parsed.numChannels as number) > MAX_AUDIO_CHANNELS
  ) {
    throw new Error(`Bundled asset "${entry.id}" has malformed metadata`);
  }
  const sampleCount = entry.pcm.byteLength / Float32Array.BYTES_PER_ELEMENT;
  if (sampleCount > MAX_AUDIO_SAMPLES || sampleCount % (parsed.numChannels as number) !== 0) {
    throw new Error(`Bundled asset "${entry.id}" PCM does not match its channel count`);
  }
  const numFrames = sampleCount / (parsed.numChannels as number);
  if (numFrames < 1) {
    throw new Error(`Bundled asset "${entry.id}" must contain at least one audio frame`);
  }
  if (parsed.numFrames !== undefined && parsed.numFrames !== numFrames) {
    throw new Error(`Bundled asset "${entry.id}" PCM does not match its frame count`);
  }
  const audio = floatsFromPcm(entry.pcm);
  const computedId = computeAssetId(
    audio,
    parsed.sampleRate as number,
    parsed.numChannels as number,
  );
  if (CONTENT_ID_PATTERN.test(entry.id) && computedId.toLowerCase() !== entry.id.toLowerCase()) {
    throw new Error(`Bundled asset "${entry.id}" does not match its content id`);
  }
  return {
    id: entry.id,
    meta: {
      id: entry.id,
      name: parsed.name,
      sampleRate: parsed.sampleRate as number,
      numChannels: parsed.numChannels as number,
      numFrames,
      ...(parsed.tags ? { tags: parsed.tags } : {}),
    },
    audio,
  };
}

/** Parses and validates one bundled SoundFont pair without touching storage. */
export function prepareFontRestore(entry: SzdMediaBundle['fonts'][number]): PreparedFontRestore {
  const parsed = JSON.parse(textDecoder.decode(entry.meta)) as Partial<SoundFontMeta>;
  if (
    parsed.id !== entry.id ||
    typeof parsed.name !== 'string' ||
    parsed.name.length === 0 ||
    (parsed.byteLength !== undefined && parsed.byteLength !== entry.sf2.byteLength) ||
    entry.sf2.byteLength === 0
  ) {
    throw new Error(`Bundled font "${entry.id}" has malformed metadata`);
  }
  const computedId = computeFontId(entry.sf2);
  if (CONTENT_ID_PATTERN.test(entry.id) && computedId.toLowerCase() !== entry.id.toLowerCase()) {
    throw new Error(`Bundled font "${entry.id}" does not match its content id`);
  }
  return {
    id: entry.id,
    meta: { id: entry.id, name: parsed.name, byteLength: entry.sf2.byteLength },
    data: new Uint8Array(entry.sf2),
  };
}

/** Returns true for an identical existing asset, false when the id is unused. */
export async function preflightAssetRestore(entry: PreparedAssetRestore): Promise<boolean> {
  try {
    const existing = await loadAsset(entry.id);
    const existingBytes = pcmBytes(existing.channels);
    const incomingBytes = new Uint8Array(
      entry.audio.buffer,
      entry.audio.byteOffset,
      entry.audio.byteLength,
    );
    if (
      existing.meta.sampleRate !== entry.meta.sampleRate ||
      existing.meta.numChannels !== entry.meta.numChannels ||
      !equalBytes(existingBytes, incomingBytes)
    ) {
      throw new MediaRestoreConflictError('asset', entry.id);
    }
    return true;
  } catch (error) {
    if (error instanceof AssetNotFoundError) return false;
    throw error;
  }
}

/** Returns true for an identical existing font, false when the id is unused. */
export async function preflightFontRestore(entry: PreparedFontRestore): Promise<boolean> {
  try {
    const existing = await loadFont(entry.id);
    if (!equalBytes(existing, entry.data)) {
      throw new MediaRestoreConflictError('font', entry.id);
    }
    return true;
  } catch (error) {
    if (error instanceof FontNotFoundError) return false;
    throw error;
  }
}

/**
 * Writes the document-referenced media back into the OPFS stores after a full
 * validation/conflict preflight. Existing ids are never overwritten with
 * different bytes; a failed commit removes every pair created by this call.
 *
 * @param doc The imported document whose references authorize bundle entries.
 * @param bundle The media extracted by {@link decodeSzdBundle}.
 */
async function restoreProjectBundleUnlocked(
  doc: ProjectDocument,
  bundle: SzdMediaBundle,
): Promise<void> {
  const referencedAssets = collectReferencedAssetIds(doc);
  const referencedFonts = collectReferencedFontIds(doc);
  const assetEntries = bundle.assets.filter((entry) => referencedAssets.has(entry.id));
  const fontEntries = bundle.fonts.filter((entry) => referencedFonts.has(entry.id));
  if (new Set(assetEntries.map((entry) => entry.id)).size !== assetEntries.length) {
    throw new Error('Bundled project contains duplicate referenced asset ids');
  }
  if (new Set(fontEntries.map((entry) => entry.id)).size !== fontEntries.length) {
    throw new Error('Bundled project contains duplicate referenced font ids');
  }

  const existingAssets = new Set<string>();
  const existingFonts = new Set<string>();
  // Decode one PCM entry for preflight, then immediately release it before
  // touching the next. A large .szd must not retain Float32 copies for every
  // bundled asset at once merely to establish conflict-free atomicity.
  for (const rawEntry of assetEntries) {
    const entry = prepareAssetRestore(rawEntry);
    if (await preflightAssetRestore(entry)) existingAssets.add(entry.id);
  }
  for (const rawEntry of fontEntries) {
    const entry = prepareFontRestore(rawEntry);
    if (await preflightFontRestore(entry)) existingFonts.add(entry.id);
  }

  const createdAssets: string[] = [];
  const createdFonts: string[] = [];
  try {
    for (const rawEntry of assetEntries) {
      const entry = prepareAssetRestore(rawEntry);
      if (existingAssets.has(entry.id)) continue;
      createdAssets.push(entry.id);
      await saveAssetWithStatusUnlocked(
        {
          id: entry.id,
          name: entry.meta.name,
          sampleRate: entry.meta.sampleRate,
          numChannels: entry.meta.numChannels,
          ...(entry.meta.tags ? { tags: entry.meta.tags } : {}),
        },
        entry.audio,
      );
    }
    for (const rawEntry of fontEntries) {
      const entry = prepareFontRestore(rawEntry);
      if (existingFonts.has(entry.id)) continue;
      createdFonts.push(entry.id);
      await saveFontWithStatusUnlocked({ id: entry.id, name: entry.meta.name }, entry.data);
    }
  } catch (error) {
    await Promise.allSettled([
      ...createdAssets.map((id) => deleteAssetUnlocked(id)),
      ...createdFonts.map((id) => deleteFontUnlocked(id)),
    ]);
    throw error;
  }
}

export function restoreProjectBundle(doc: ProjectDocument, bundle: SzdMediaBundle): Promise<void> {
  return withPersistenceMutationLock(() => restoreProjectBundleUnlocked(doc, bundle));
}
