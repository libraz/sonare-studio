/**
 * .szd project file codec: a zip archive (via fflate) holding the plain-JSON
 * ProjectDocument plus a small metadata entry. This module is pure byte
 * transformation — it never touches the store, the wasm Project, the clock or
 * any browser storage; callers provide timestamps and handle I/O
 * (src/persistence/opfs.ts, src/persistence/local-file.ts).
 */

import { strFromU8, strToU8, zipSync } from 'fflate';
import {
  type ArchiveLimits,
  ArchivePreflightError,
  type ArchivePreflightReport,
  preflightAndUnzip,
  preflightAndUnzipInWorker,
} from '@/persistence/archive-preflight';
import {
  MAX_PROJECT_ARCHIVE_COMPRESSED_BYTES,
  MAX_PROJECT_ARCHIVE_ENTRIES,
  MAX_PROJECT_ARCHIVE_ENTRY_BYTES,
  MAX_PROJECT_ARCHIVE_EXPANDED_BYTES,
} from '@/persistence/resource-limits';
import { PROJECT_DOCUMENT_SCHEMA_VERSION, type ProjectDocument } from '@/project/serialization';

/** File extension used by project archives. */
export const SZD_FILE_EXTENSION = '.szd';

/** Application identifier written into the archive metadata. */
export const SZD_APP_ID = 'sonare-studio';

/** Zip entry name of the serialized project document. */
const PROJECT_ENTRY = 'project.json';

/** Zip entry name of the archive metadata. */
const META_ENTRY = 'meta.json';

/** Zip directory holding bundled audio-asset payloads + sidecars. */
const ASSETS_PREFIX = 'assets/';

/** Zip directory holding bundled SoundFont payloads + sidecars. */
const FONTS_PREFIX = 'fonts/';

/**
 * Fixed zip-entry timestamp used when the caller provides no savedAt, keeping
 * encoding deterministic (zip DOS times only cover 1980-2099, so the Unix
 * epoch cannot serve as the neutral value).
 */
const DEFAULT_ZIP_MTIME = '2000-01-01T12:00:00Z';

/** Caller-provided metadata for {@link encodeSzd} (the encoder reads no clock). */
export interface SzdEncodeMeta {
  /** Save timestamp as an ISO 8601 string; omitted when the caller has none. */
  savedAt?: string;
}

/** One bundled audio asset: its sidecar JSON bytes and raw PCM payload. */
export interface SzdAssetEntry {
  /** Asset id (zip base name; must be a safe file name). */
  id: string;
  /** Metadata sidecar bytes (the asset store's `<id>.json`). */
  meta: Uint8Array;
  /** Raw interleaved float32 PCM bytes (the asset store's `<id>.pcm`). */
  pcm: Uint8Array;
}

/** One bundled SoundFont: its sidecar JSON bytes and raw SF2 payload. */
export interface SzdFontEntry {
  /** Font id (zip base name; must be a safe file name). */
  id: string;
  /** Metadata sidecar bytes (the font store's `<id>.json`). */
  meta: Uint8Array;
  /** Raw SF2 bytes (the font store's `<id>.sf2`). */
  sf2: Uint8Array;
}

/**
 * Media bundled inside a .szd archive so a project carries its audio and
 * SoundFonts across machines (OPFS slots keep the media out-of-band, but disk
 * export/import has no shared store to draw from).
 */
export interface SzdMediaBundle {
  /** Bundled audio assets referenced by the document. */
  assets: ReadonlyArray<SzdAssetEntry>;
  /** Bundled SoundFonts referenced by the document. */
  fonts: ReadonlyArray<SzdFontEntry>;
}

/** Base name pattern shared with the asset/font stores (safe zip entry names). */
const MEDIA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Shape of the meta.json entry inside a .szd archive. */
export interface SzdMetaDocument {
  /** Project document schema version, duplicated for cheap inspection. */
  schemaVersion: number;
  /** Application identifier; see {@link SZD_APP_ID}. */
  app: string;
  /** Save timestamp as an ISO 8601 string, when the writer provided one. */
  savedAt?: string;
}

/** Error thrown by {@link decodeSzd} when bytes are not a usable .szd archive. */
export class SzdFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SzdFormatError';
  }
}

function szdLimits(overrides: Partial<ArchiveLimits> = {}): Partial<ArchiveLimits> {
  return {
    maxCompressedBytes: MAX_PROJECT_ARCHIVE_COMPRESSED_BYTES,
    maxEntries: MAX_PROJECT_ARCHIVE_ENTRIES,
    maxEntryBytes: MAX_PROJECT_ARCHIVE_ENTRY_BYTES,
    maxUncompressedBytes: MAX_PROJECT_ARCHIVE_EXPANDED_BYTES,
    ...overrides,
  };
}

function unzipSzdWithReport(
  bytes: Uint8Array,
  limits: Partial<ArchiveLimits> = {},
): { entries: Record<string, Uint8Array>; report: ArchivePreflightReport } {
  try {
    return preflightAndUnzip(bytes, szdLimits(limits));
  } catch (error) {
    if (error instanceof ArchivePreflightError) {
      throw new SzdFormatError(`Invalid project file: ${error.message}`);
    }
    throw error;
  }
}

function unzipSzd(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSzdWithReport(bytes).entries;
}

async function unzipSzdInWorker(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<Record<string, Uint8Array>> {
  try {
    return (await preflightAndUnzipInWorker(bytes, szdLimits(), signal)).entries;
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (error instanceof ArchivePreflightError) {
      throw new SzdFormatError(`Invalid project file: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Encodes a project document into .szd bytes.
 *
 * The archive contains `project.json` (the document) and `meta.json`
 * ({@link SzdMetaDocument}). Encoding is deterministic for a given input:
 * zip entry timestamps derive from `meta.savedAt` (epoch zero when absent).
 *
 * @param doc Document from serializeProject() or a template.
 * @param meta Optional caller-provided metadata (e.g. the save timestamp).
 * @returns Zip archive bytes ready for OPFS or a file download.
 */
export function encodeSzd(
  doc: ProjectDocument,
  meta: SzdEncodeMeta = {},
  bundle?: SzdMediaBundle,
): Uint8Array {
  const metaDoc: SzdMetaDocument = {
    schemaVersion: doc.schemaVersion,
    app: SZD_APP_ID,
  };
  if (meta.savedAt !== undefined) metaDoc.savedAt = meta.savedAt;
  const entries: Record<string, Uint8Array> = {
    [PROJECT_ENTRY]: strToU8(JSON.stringify(doc)),
    [META_ENTRY]: strToU8(JSON.stringify(metaDoc)),
  };
  for (const asset of bundle?.assets ?? []) {
    if (!MEDIA_ID_PATTERN.test(asset.id)) continue;
    entries[`${ASSETS_PREFIX}${asset.id}.json`] = asset.meta;
    entries[`${ASSETS_PREFIX}${asset.id}.pcm`] = asset.pcm;
  }
  for (const font of bundle?.fonts ?? []) {
    if (!MEDIA_ID_PATTERN.test(font.id)) continue;
    entries[`${FONTS_PREFIX}${font.id}.json`] = font.meta;
    entries[`${FONTS_PREFIX}${font.id}.sf2`] = font.sf2;
  }
  return zipSync(entries, { mtime: meta.savedAt ?? DEFAULT_ZIP_MTIME });
}

/** Parses a zip entry as JSON, mapping failures to {@link SzdFormatError}. */
function parseEntryJson(bytes: Uint8Array, entryName: string): unknown {
  try {
    return JSON.parse(strFromU8(bytes));
  } catch {
    throw new SzdFormatError(`Invalid project file: ${entryName} is not valid JSON`);
  }
}

/**
 * Validates the decoded project.json shape, throwing helpful errors. Only the
 * top-level structure is checked here; deeper validation happens when the
 * document is replayed through the Project API on load.
 */
function validateDocument(value: unknown): ProjectDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SzdFormatError('Invalid project file: project.json is not a JSON object');
  }
  const doc = value as Partial<ProjectDocument>;
  const version = doc.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new SzdFormatError(`Invalid project file: bad schema version (${String(version)})`);
  }
  if (version > PROJECT_DOCUMENT_SCHEMA_VERSION) {
    throw new SzdFormatError(
      `This project uses schema version ${version}, but this app supports up to ` +
        `${PROJECT_DOCUMENT_SCHEMA_VERSION}; it was likely saved by a newer app version`,
    );
  }
  if (typeof doc.name !== 'string' || typeof doc.sampleRate !== 'number') {
    throw new SzdFormatError('Invalid project file: missing project name or sample rate');
  }
  for (const field of [
    'tempoSegments',
    'timeSignatures',
    'tracks',
    'markers',
    'sections',
  ] as const) {
    if (!Array.isArray(doc[field])) {
      throw new SzdFormatError(`Invalid project file: "${field}" is not an array`);
    }
    if (
      !doc[field].every((item) => typeof item === 'object' && item !== null && !Array.isArray(item))
    ) {
      throw new SzdFormatError(`Invalid project file: "${field}" contains a non-object entry`);
    }
  }
  // Optional collections must still be arrays when present (older documents
  // simply omit them; loading injects the defaults).
  for (const field of ['masterAutomation', 'chords', 'midiCcBindings'] as const) {
    if (doc[field] !== undefined && !Array.isArray(doc[field])) {
      throw new SzdFormatError(`Invalid project file: "${field}" is not an array`);
    }
    if (
      doc[field] !== undefined &&
      !doc[field].every((item) => typeof item === 'object' && item !== null && !Array.isArray(item))
    ) {
      throw new SzdFormatError(`Invalid project file: "${field}" contains a non-object entry`);
    }
  }
  return doc as ProjectDocument;
}

/**
 * Decodes .szd bytes back into a project document.
 *
 * @param bytes Archive bytes produced by {@link encodeSzd}.
 * @returns The contained project document, schema-checked.
 * @throws SzdFormatError when the bytes are not a zip archive, the project
 *   entry is missing or malformed, the schema version is unsupported, or the
 *   archive was written by a different application.
 */
function decodeSzdEntries(entries: Record<string, Uint8Array>): ProjectDocument {
  // Reject archives written by other apps when their metadata says so; absent
  // or unreadable metadata is tolerated (project.json alone is sufficient).
  const metaBytes = entries[META_ENTRY];
  if (metaBytes) {
    let metaDoc: unknown = null;
    try {
      metaDoc = JSON.parse(strFromU8(metaBytes));
    } catch {
      // Tolerated: meta.json is advisory.
    }
    if (typeof metaDoc === 'object' && metaDoc !== null) {
      const app = (metaDoc as Partial<SzdMetaDocument>).app;
      if (typeof app === 'string' && app !== SZD_APP_ID) {
        throw new SzdFormatError(`Invalid project file: written by another application (${app})`);
      }
    }
  }

  const projectBytes = entries[PROJECT_ENTRY];
  if (!projectBytes) {
    throw new SzdFormatError(`Invalid project file: missing ${PROJECT_ENTRY} entry`);
  }
  return validateDocument(parseEntryJson(projectBytes, PROJECT_ENTRY));
}

export function decodeSzd(bytes: Uint8Array): ProjectDocument {
  return decodeSzdEntries(unzipSzd(bytes));
}

/** Decodes with a caller-provided cumulative budget and reports retained expansion. */
export function decodeSzdWithResourceReport(
  bytes: Uint8Array,
  limits: Partial<ArchiveLimits>,
): { document: ProjectDocument; report: ArchivePreflightReport } {
  const decoded = unzipSzdWithReport(bytes, limits);
  return { document: decodeSzdEntries(decoded.entries), report: decoded.report };
}

/**
 * Extracts the bundled media (audio assets + SoundFonts) from a .szd archive.
 *
 * Each asset/font is a `<id>.json` sidecar paired with a payload (`.pcm` for
 * assets, `.sf2` for fonts); entries missing either half are skipped. Archives
 * written before media bundling simply yield empty arrays.
 *
 * @param bytes Archive bytes produced by {@link encodeSzd}.
 * @returns The bundled assets and fonts (empty when none are present).
 * @throws SzdFormatError when the bytes are not a readable zip archive.
 */
function decodeSzdBundleEntries(entries: Record<string, Uint8Array>): SzdMediaBundle {
  const assets: SzdAssetEntry[] = [];
  const fonts: SzdFontEntry[] = [];
  for (const [name, data] of Object.entries(entries)) {
    if (name.startsWith(ASSETS_PREFIX) && name.endsWith('.pcm')) {
      const id = name.slice(ASSETS_PREFIX.length, -'.pcm'.length);
      const meta = entries[`${ASSETS_PREFIX}${id}.json`];
      if (meta && MEDIA_ID_PATTERN.test(id)) assets.push({ id, meta, pcm: data });
    } else if (name.startsWith(FONTS_PREFIX) && name.endsWith('.sf2')) {
      const id = name.slice(FONTS_PREFIX.length, -'.sf2'.length);
      const meta = entries[`${FONTS_PREFIX}${id}.json`];
      if (meta && MEDIA_ID_PATTERN.test(id)) fonts.push({ id, meta, sf2: data });
    }
  }
  return { assets, fonts };
}

export function decodeSzdBundle(bytes: Uint8Array): SzdMediaBundle {
  return decodeSzdBundleEntries(unzipSzd(bytes));
}

/** Parses a project document and its media bundle from one ZIP expansion. */
export function decodeSzdWithBundle(bytes: Uint8Array): {
  document: ProjectDocument;
  bundle: SzdMediaBundle;
} {
  const entries = unzipSzd(bytes);
  return {
    document: decodeSzdEntries(entries),
    bundle: decodeSzdBundleEntries(entries),
  };
}

/** Parses an imported project and bundle once on fflate's worker path. */
export async function decodeSzdWithBundleInWorker(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<{ document: ProjectDocument; bundle: SzdMediaBundle }> {
  const entries = await unzipSzdInWorker(bytes, signal);
  signal?.throwIfAborted();
  return {
    document: decodeSzdEntries(entries),
    bundle: decodeSzdBundleEntries(entries),
  };
}

/**
 * Reads the metadata entry of a .szd archive without validating the document
 * (useful for listings that show save timestamps).
 *
 * @param bytes Archive bytes produced by {@link encodeSzd}.
 * @returns The metadata, or null when absent or unreadable.
 */
export function readSzdMeta(bytes: Uint8Array): SzdMetaDocument | null {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSzd(bytes);
  } catch {
    return null;
  }
  const metaBytes = entries[META_ENTRY];
  if (!metaBytes) return null;
  try {
    const value = JSON.parse(strFromU8(metaBytes)) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    const meta = value as Partial<SzdMetaDocument>;
    if (typeof meta.schemaVersion !== 'number' || typeof meta.app !== 'string') return null;
    return meta as SzdMetaDocument;
  } catch {
    return null;
  }
}
