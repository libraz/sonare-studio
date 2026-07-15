/**
 * Whole-browser backup archive for OPFS-hosted sonare data.
 *
 * A .szd project export is intentionally project-scoped. This archive is the
 * broader safety net for browser-only storage: every saved project slot, every
 * shared audio asset and every SoundFont is packed into one zip so a user can
 * recover after clearing site data or moving to a new browser profile.
 */

import { AsyncZipDeflate, strToU8, Zip } from 'fflate';
import { preflightAndUnzipInWorker } from '@/persistence/archive-preflight';
import {
  deleteAsset,
  interleaveChannels,
  listAssets,
  loadAsset,
  saveAsset,
} from '@/persistence/assets';
import {
  collectReferencedAssetIds,
  collectReferencedFontIds,
  preflightAssetRestore,
  preflightFontRestore,
  prepareAssetRestore,
  prepareFontRestore,
} from '@/persistence/bundle';
import {
  deleteProject,
  listProjects,
  loadProject,
  ProjectNotFoundError,
  sanitizeProjectName,
  saveProject,
} from '@/persistence/opfs';
import { decodeSzd } from '@/persistence/szd';
import { deleteFont, listFonts, loadFont, saveFont } from '@/project/fonts';

export const BROWSER_BACKUP_FILE_EXTENSION = '.sonare-backup.zip';

const BACKUP_VERSION = 1;
const BACKUP_APP_ID = 'sonare-studio';
const BACKUP_KIND = 'browser-backup';
const META_ENTRY = 'meta.json';
const PROJECTS_PREFIX = 'projects/';
const ASSETS_PREFIX = 'assets/';
const FONTS_PREFIX = 'fonts/';
const MEDIA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface BrowserBackupMeta {
  app: string;
  kind: string;
  version: number;
  savedAt: string;
  projects: number;
  assets: number;
  fonts: number;
}

export interface BrowserBackupRestoreResult {
  projects: number;
  assets: number;
  fonts: number;
}

/** Raw interleaved-PCM bytes view of planar channels (a fresh copy). */
function pcmBytes(channels: ReadonlyArray<Float32Array>): Uint8Array {
  const interleaved = interleaveChannels(channels);
  return new Uint8Array(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength).slice();
}

function projectEntryName(name: string): string {
  return `${PROJECTS_PREFIX}${encodeURIComponent(name)}.szd`;
}

function projectNameFromEntry(entryName: string): string | null {
  if (!entryName.startsWith(PROJECTS_PREFIX) || !entryName.endsWith('.szd')) return null;
  const encoded = entryName.slice(PROJECTS_PREFIX.length, -'.szd'.length);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function parseJson<T>(bytes: Uint8Array): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

function concatZipChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function createBackupZipWriter(
  savedAt: string,
  signal?: AbortSignal,
): {
  add(name: string, bytes: Uint8Array): void;
  close(): Promise<Uint8Array>;
} {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let resolveResult!: (bytes: Uint8Array) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<Uint8Array>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      rejectResult(error);
      return;
    }
    const copy = new Uint8Array(chunk);
    chunks.push(copy);
    totalBytes += copy.byteLength;
    if (final) resolveResult(concatZipChunks(chunks, totalBytes));
  });
  return {
    add(name, bytes): void {
      signal?.throwIfAborted();
      const file = new AsyncZipDeflate(name, { level: 6 });
      file.mtime = new Date(savedAt);
      zip.add(file);
      file.push(bytes, true);
    },
    async close(): Promise<Uint8Array> {
      try {
        signal?.throwIfAborted();
        zip.end();
        return await result;
      } catch (error) {
        zip.terminate();
        throw error;
      }
    },
  };
}

/**
 * Creates one zip containing all saved projects plus shared OPFS media stores.
 */
export async function createBrowserBackup(
  savedAt = new Date().toISOString(),
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const zip = createBackupZipWriter(savedAt, signal);
  let projectCount = 0;
  let assetCount = 0;
  let fontCount = 0;

  for (const project of await listProjects()) {
    signal?.throwIfAborted();
    zip.add(projectEntryName(project.name), await loadProject(project.name));
    projectCount++;
  }

  for (const asset of await listAssets()) {
    try {
      const loaded = await loadAsset(asset.id);
      signal?.throwIfAborted();
      zip.add(`${ASSETS_PREFIX}${asset.id}.json`, strToU8(JSON.stringify(loaded.meta)));
      zip.add(`${ASSETS_PREFIX}${asset.id}.pcm`, pcmBytes(loaded.channels));
      assetCount++;
    } catch {
      if (signal?.aborted) signal.throwIfAborted();
      // Keep the archive usable if one shared asset sidecar/payload is broken.
    }
  }

  for (const font of await listFonts()) {
    try {
      zip.add(`${FONTS_PREFIX}${font.id}.json`, strToU8(JSON.stringify(font)));
      zip.add(`${FONTS_PREFIX}${font.id}.sf2`, new Uint8Array(await loadFont(font.id)));
      signal?.throwIfAborted();
      fontCount++;
    } catch {
      if (signal?.aborted) signal.throwIfAborted();
      // Keep the archive usable if one shared font sidecar/payload is broken.
    }
  }

  const meta: BrowserBackupMeta = {
    app: BACKUP_APP_ID,
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    savedAt,
    projects: projectCount,
    assets: assetCount,
    fonts: fontCount,
  };
  zip.add(META_ENTRY, strToU8(JSON.stringify(meta)));
  return zip.close();
}

/** Restores a browser backup as one preflighted, rollback-capable transaction. */
export async function restoreBrowserBackup(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<BrowserBackupRestoreResult> {
  const entries = (
    await preflightAndUnzipInWorker(
      bytes,
      {
        maxEntries: 20_000,
        maxEntryBytes: 512 * 1024 * 1024,
        maxUncompressedBytes: 1024 * 1024 * 1024,
      },
      signal,
    )
  ).entries;
  const meta = entries[META_ENTRY]
    ? parseJson<Partial<BrowserBackupMeta>>(entries[META_ENTRY])
    : null;
  if (meta?.app !== BACKUP_APP_ID || meta.kind !== BACKUP_KIND || meta.version !== BACKUP_VERSION) {
    throw new Error('Invalid sonare browser backup.');
  }

  const projects: Array<{ name: string; bytes: Uint8Array }> = [];
  const projectNames = new Set<string>();
  const referencedAssets = new Set<string>();
  const referencedFonts = new Set<string>();
  for (const [entryName, data] of Object.entries(entries)) {
    signal?.throwIfAborted();
    const archiveName = projectNameFromEntry(entryName);
    if (!archiveName) continue;
    const name = sanitizeProjectName(archiveName);
    if (projectNames.has(name)) {
      throw new Error(`Browser backup contains colliding project name: "${name}"`);
    }
    projectNames.add(name);
    const doc = decodeSzd(data);
    for (const id of collectReferencedAssetIds(doc)) referencedAssets.add(id);
    for (const id of collectReferencedFontIds(doc)) referencedFonts.add(id);
    projects.push({ name, bytes: data });
  }

  const assets = Object.entries(entries).flatMap(([entryName, data]) => {
    if (!entryName.startsWith(ASSETS_PREFIX) || !entryName.endsWith('.pcm')) return [];
    const id = entryName.slice(ASSETS_PREFIX.length, -'.pcm'.length);
    if (!MEDIA_ID_PATTERN.test(id) || !referencedAssets.has(id)) return [];
    const metaBytes = entries[`${ASSETS_PREFIX}${id}.json`];
    return metaBytes ? [prepareAssetRestore({ id, meta: metaBytes, pcm: data })] : [];
  });
  const fonts = Object.entries(entries).flatMap(([entryName, data]) => {
    if (!entryName.startsWith(FONTS_PREFIX) || !entryName.endsWith('.sf2')) return [];
    const id = entryName.slice(FONTS_PREFIX.length, -'.sf2'.length);
    if (!MEDIA_ID_PATTERN.test(id) || !referencedFonts.has(id)) return [];
    const metaBytes = entries[`${FONTS_PREFIX}${id}.json`];
    return metaBytes ? [prepareFontRestore({ id, meta: metaBytes, sf2: data })] : [];
  });

  const existingAssets = new Set<string>();
  const existingFonts = new Set<string>();
  for (const entry of assets) {
    if (await preflightAssetRestore(entry)) existingAssets.add(entry.id);
    signal?.throwIfAborted();
  }
  for (const entry of fonts) {
    if (await preflightFontRestore(entry)) existingFonts.add(entry.id);
    signal?.throwIfAborted();
  }
  const previousProjects = new Map<string, Uint8Array | null>();
  for (const project of projects) {
    try {
      previousProjects.set(project.name, await loadProject(project.name));
      signal?.throwIfAborted();
    } catch (error) {
      if (error instanceof ProjectNotFoundError) previousProjects.set(project.name, null);
      else throw error;
    }
  }

  const createdAssets: string[] = [];
  const createdFonts: string[] = [];
  try {
    for (const entry of assets) {
      if (existingAssets.has(entry.id)) continue;
      createdAssets.push(entry.id);
      await saveAsset(
        {
          id: entry.id,
          name: entry.meta.name,
          sampleRate: entry.meta.sampleRate,
          numChannels: entry.meta.numChannels,
          ...(entry.meta.tags ? { tags: entry.meta.tags } : {}),
        },
        entry.audio,
      );
      signal?.throwIfAborted();
    }
    for (const entry of fonts) {
      if (existingFonts.has(entry.id)) continue;
      createdFonts.push(entry.id);
      await saveFont({ id: entry.id, name: entry.meta.name }, entry.data);
      signal?.throwIfAborted();
    }
    for (const project of projects) {
      await saveProject(project.name, project.bytes);
      signal?.throwIfAborted();
    }
  } catch (error) {
    await Promise.allSettled([
      ...projects.map(async (project) => {
        const previous = previousProjects.get(project.name);
        if (previous) await saveProject(project.name, previous);
        else await deleteProject(project.name);
      }),
      ...createdAssets.map((id) => deleteAsset(id)),
      ...createdFonts.map((id) => deleteFont(id)),
    ]);
    throw error;
  }

  return { projects: projects.length, assets: assets.length, fonts: fonts.length };
}
