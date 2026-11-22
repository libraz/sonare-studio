/**
 * DAWproject exporter: turns a plain project document into a DAWproject
 * archive (https://github.com/bitwig/dawproject), the open interchange format
 * several desktop DAWs read and write.
 *
 * The archive is a zip holding project.xml (structure, transport, arrangement),
 * metadata.xml (title) and, optionally, the referenced audio assets embedded
 * as 24-bit WAV files under audio/. The XML is built with a small pure
 * serializer (./xml.ts), so the exporter runs unchanged inside module workers
 * and jsdom tests.
 *
 * Mapping notes (deliberate deviations, all lossy-by-design):
 * - Sections have no DAWproject element; each section start is exported as a
 *   cue marker named "Section: <name>".
 * - Enabled audio warps are exported as standard beats-to-seconds Warps;
 *   disabled warp metadata remains a plain file reference.
 * - Per-clip gain has no DAWproject attribute and is dropped.
 * - Per-clip MIDI expression lanes have no portable DAWproject representation.
 *   They are kept in the separate Sonare metadata entry so project.xml remains
 *   schema-valid for other DAWs.
 * - A VCA group's own fader is not a DAWproject concept; its dB offset is
 *   folded into each member track's channel volume for portable playback, and
 *   sonare-scoped metadata preserves VCA groups/membership for round-trips.
 * - Send buses are exported as DAWproject effect channels; track output bus
 *   routing and pre/post sends are preserved when they address those buses.
 * - Sonare insert effects are exported as generic BuiltinDevice entries so
 *   sonare-to-sonare DAWproject round-trips preserve the chain. Insert
 *   sidechain key sources are preserved as sonare-scoped track indexes on
 *   track, bus and master strips. Other DAWs may ignore these vendor-specific
 *   devices.
 * - Instruments and the mastering chain are vendor-specific device state with
 *   no portable representation; channel volume/pan, mute/solo and fader/pan
 *   automation travel.
 * - Audio-clip content times use seconds (per the format's convention for
 *   media), converted through the project tempo map.
 */

import { strToU8 } from 'fflate';
import { encodeWav } from '@/export/wav';
import { projectFilename } from '@/lib/filename';
import { createStreamingZipWriter, DETERMINISTIC_ZIP_MTIME } from '@/lib/streaming-zip';
import { type LoadedAudioAsset, loadAsset } from '@/persistence/assets';
import {
  MAX_DAWPROJECT_ARCHIVE_BYTES,
  MAX_PROJECT_ARCHIVE_ENTRY_BYTES,
  MAX_PROJECT_ARCHIVE_EXPANDED_BYTES,
} from '@/persistence/resource-limits';
import {
  createMediaCompletenessReport,
  type MediaCompletenessIssue,
  type MediaCompletenessReport,
  mediaFailureIssues,
} from '@/project/media-completeness';
import type { DocumentClip, ProjectDocument } from '@/project/serialization';
import { DEFAULT_TEMPO_BPM, type NormalizedTempoMap, normalizeTempoMap } from '@/project/tempo-map';
import { audioContentOriginPpq, audioContentPpqToSeconds } from './audio-time';
import type { AudioAssetEntry } from './clip-export';
import { projectElement } from './project-xml';
import {
  createSonareDawprojectMetadata,
  SONARE_DAWPROJECT_METADATA_ENTRY,
} from './sonare-metadata';
import { serializeXml, type XmlElement } from './xml';

/** File extension of DAWproject archives. */
export const DAWPROJECT_FILE_EXTENSION = '.dawproject';

/** Default application version (override via options.applicationVersion). */
const DEFAULT_APPLICATION_VERSION = '0.1.0';

/** Options for {@link exportDawproject}. */
export interface DawprojectExportOptions {
  /**
   * True embeds every referenced audio asset as a 24-bit WAV zip entry under
   * audio/ (deduplicated by asset id). False keeps the clip/file structure
   * but writes no audio payloads; file durations are then estimated from the
   * clip windows.
   */
  includeAudio: boolean;
  /**
   * Reserved: rendering MIDI tracks to audio is not supported by this
   * exporter; MIDI tracks always export as note clips.
   */
  renderMidiTracks?: false;
  /** Audio asset loader (defaults to the OPFS asset store's loadAsset). */
  loadAudioAsset?: (assetId: string) => Promise<LoadedAudioAsset>;
  /** Application version written to the <Application> element. */
  applicationVersion?: string;
  /** Cancels asset loading/encoding/ZIP construction between entries. */
  signal?: AbortSignal;
  /**
   * Size budget the export must stay within, defaulting to the values the
   * importer enforces (resource-limits.ts). Exceeding any of them throws a
   * {@link DawprojectSizeError} so the export never yields an unopenable file.
   */
  limits?: DawprojectExportLimits;
}

/** Byte budgets applied while building a DAWproject archive. */
export interface DawprojectExportLimits {
  /** Maximum compressed archive size (default {@link MAX_DAWPROJECT_ARCHIVE_BYTES}). */
  maxArchiveBytes: number;
  /** Maximum total uncompressed embedded audio (default expanded-archive limit). */
  maxExpandedBytes: number;
  /** Maximum single embedded audio payload (default per-entry limit). */
  maxEntryBytes: number;
}

const DEFAULT_DAWPROJECT_EXPORT_LIMITS: DawprojectExportLimits = {
  maxArchiveBytes: MAX_DAWPROJECT_ARCHIVE_BYTES,
  maxExpandedBytes: MAX_PROJECT_ARCHIVE_EXPANDED_BYTES,
  maxEntryBytes: MAX_PROJECT_ARCHIVE_ENTRY_BYTES,
};

export interface DawprojectExportResult {
  bytes: Uint8Array;
  completeness: MediaCompletenessReport;
  media: {
    embeddedAssetIds: string[];
    missingAssetIds: string[];
  };
}

/** True when the clip carries audio content. */
function isAudioClip(clip: DocumentClip): boolean {
  return (clip.kind ?? 'midi') === 'audio';
}

/** Builds the zip entry path for an asset id, keeping paths unique. */
function audioEntryPath(assetId: string, usedPaths: Set<string>): string {
  const base = assetId.replace(/[^A-Za-z0-9._-]/g, '_');
  let path = `audio/${base}.wav`;
  for (let n = 2; usedPaths.has(path); n++) {
    path = `audio/${base}-${n}.wav`;
  }
  usedPaths.add(path);
  return path;
}

/**
 * Error thrown when a DAWproject export would exceed the same budget the
 * importer enforces, so the export never yields an archive this app could not
 * reopen (and never builds an unbounded in-memory buffer set).
 */
export class DawprojectSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DawprojectSizeError';
  }
}

/**
 * Resolves every audio asset referenced by the document. When embedding is on,
 * assets are loaded and encoded as 24-bit WAV; assets that fail to load (or
 * everything, when embedding is off) keep their structural entry with media
 * facts estimated from the document (stereo at the project sample rate, long
 * enough to cover every referencing clip window).
 */
async function collectAudioAssets(
  doc: ProjectDocument,
  tempoMap: NormalizedTempoMap,
  includeAudio: boolean,
  loadAudio: (assetId: string) => Promise<LoadedAudioAsset>,
  limits: DawprojectExportLimits,
  signal?: AbortSignal,
): Promise<{ assets: Map<string, AudioAssetEntry>; missingAssetIds: string[] }> {
  const assets = new Map<string, AudioAssetEntry>();
  const missingAssetIds: string[] = [];
  const usedPaths = new Set<string>();
  // Embedded WAV bytes accumulate in memory; bound them by the same expanded
  // budget the importer enforces so a too-large project fails before encoding
  // media it could never re-import (and never holds an unbounded buffer set).
  let embeddedBytes = 0;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (!isAudioClip(clip) || !clip.assetId) continue;
      const contentOriginPpq = audioContentOriginPpq(clip.startPpq, clip.sourceOffsetPpq);
      const windowSec = audioContentPpqToSeconds(
        tempoMap,
        contentOriginPpq,
        clip.sourceOffsetPpq + clip.lengthPpq,
      );
      const existing = assets.get(clip.assetId);
      if (existing) {
        // Grow the estimated duration so every clip window stays in range.
        if (existing.bytes === null && windowSec > existing.durationSec) {
          existing.durationSec = windowSec;
        }
        continue;
      }
      const entry: AudioAssetEntry = {
        path: audioEntryPath(clip.assetId, usedPaths),
        numChannels: 2,
        sampleRate: doc.sampleRate,
        durationSec: windowSec,
        bytes: null,
      };
      if (includeAudio) {
        try {
          signal?.throwIfAborted();
          const asset = await loadAudio(clip.assetId);
          signal?.throwIfAborted();
          entry.numChannels = asset.meta.numChannels;
          entry.sampleRate = asset.meta.sampleRate;
          entry.durationSec = asset.meta.numFrames / asset.meta.sampleRate;
          // DAW interchange should not silently quantize the app's float32
          // source store to CD resolution. 24-bit PCM is broadly portable and
          // preserves substantially more source fidelity.
          entry.bytes = encodeWav(asset.channels, asset.meta.sampleRate, { bitDepth: 24 });
          if (entry.bytes.byteLength > limits.maxEntryBytes) {
            throw new DawprojectSizeError(
              `Embedded audio "${clip.assetId}" is too large to export ` +
                `(${entry.bytes.byteLength} bytes; limit ${limits.maxEntryBytes})`,
            );
          }
          embeddedBytes += entry.bytes.byteLength;
          if (embeddedBytes > limits.maxExpandedBytes) {
            throw new DawprojectSizeError(
              `Project has too much embedded audio to export ` +
                `(${embeddedBytes} bytes; limit ${limits.maxExpandedBytes})`,
            );
          }
        } catch (error) {
          if (error instanceof DawprojectSizeError) throw error;
          if (signal?.aborted) signal.throwIfAborted();
          missingAssetIds.push(clip.assetId);
          // Missing or unreadable asset: keep the structural reference only.
        }
      }
      assets.set(clip.assetId, entry);
    }
  }
  return { assets, missingAssetIds };
}

/** Compresses entries incrementally so encoded media can be released immediately. */
async function buildDawprojectZip(
  entries: Iterable<readonly [string, Uint8Array]>,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const zip = createStreamingZipWriter({ mtime: DETERMINISTIC_ZIP_MTIME, signal });
  try {
    for (const [name, bytes] of entries) {
      await zip.add(name, bytes);
    }
    return await zip.close();
  } catch (error) {
    zip.abort(error);
    throw error;
  }
}

/** Builds the metadata.xml root element (title = project name). */
function metadataElement(doc: ProjectDocument): XmlElement {
  return { name: 'MetaData', children: [{ name: 'Title', text: doc.name }] };
}

/**
 * Exports a project document as a DAWproject archive.
 *
 * @param doc Plain project document (serializeProject output or equivalent).
 * @param options Export options; includeAudio controls audio payload embedding.
 * @returns The .dawproject zip bytes (deterministic for a fixed input).
 */
export async function exportDawproject(
  doc: ProjectDocument,
  options: DawprojectExportOptions,
): Promise<Uint8Array> {
  return (await exportDawprojectWithReport(doc, options)).bytes;
}

/** Exports with a structured report for audio that could not be embedded. */
export async function exportDawprojectWithReport(
  doc: ProjectDocument,
  options: DawprojectExportOptions,
): Promise<DawprojectExportResult> {
  if ((options as { renderMidiTracks?: unknown }).renderMidiTracks === true) {
    throw new RangeError('DAWproject export does not support rendering MIDI tracks to audio');
  }
  const tempoMap = normalizeTempoMap(doc.tempoSegments, DEFAULT_TEMPO_BPM);
  const loadAudio = options.loadAudioAsset ?? loadAsset;
  const limits = options.limits ?? DEFAULT_DAWPROJECT_EXPORT_LIMITS;
  options.signal?.throwIfAborted();
  const collected = await collectAudioAssets(
    doc,
    tempoMap,
    options.includeAudio,
    loadAudio,
    limits,
    options.signal,
  );
  const { assets } = collected;
  const applicationVersion = options.applicationVersion ?? DEFAULT_APPLICATION_VERSION;
  const projectXml = strToU8(
    serializeXml(projectElement(doc, assets, applicationVersion, tempoMap)),
  );
  const metadataXml = strToU8(serializeXml(metadataElement(doc)));
  const sonareMetadata = strToU8(JSON.stringify(createSonareDawprojectMetadata(doc)));
  const embeddedAssetIds: string[] = [];
  function* zipEntries(): Generator<readonly [string, Uint8Array]> {
    yield ['project.xml', projectXml];
    yield ['metadata.xml', metadataXml];
    yield [SONARE_DAWPROJECT_METADATA_ENTRY, sonareMetadata];
    for (const [id, asset] of assets) {
      const payload = asset.bytes;
      if (payload !== null) {
        embeddedAssetIds.push(id);
        yield [asset.path, payload];
        asset.bytes = null;
      }
    }
  }
  const bytes = await buildDawprojectZip(zipEntries(), options.signal);
  if (bytes.byteLength > limits.maxArchiveBytes) {
    throw new DawprojectSizeError(
      `Exported DAWproject archive is too large (${bytes.byteLength} bytes; ` +
        `limit ${limits.maxArchiveBytes})`,
    );
  }
  const issues: MediaCompletenessIssue[] = [];
  for (const id of collected.missingAssetIds) {
    issues.push(...mediaFailureIssues(doc, 'audio-asset', id, 'encode-failed'));
  }
  return {
    bytes,
    completeness: createMediaCompletenessReport(issues),
    media: { embeddedAssetIds, missingAssetIds: collected.missingAssetIds },
  };
}

/**
 * Suggests a download filename for a DAWproject export: the project name with
 * filesystem-hostile characters replaced, plus the .dawproject extension.
 */
export function dawprojectFilename(projectName: string): string {
  return projectFilename(projectName, DAWPROJECT_FILE_EXTENSION);
}
