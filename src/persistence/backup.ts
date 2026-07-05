/**
 * Whole-browser backup archive for OPFS-hosted sonare data.
 *
 * A .szd project export is intentionally project-scoped. This archive is the
 * broader safety net for browser-only storage: every saved project slot, every
 * shared audio asset and every SoundFont is packed into one zip so a user can
 * recover after clearing site data or moving to a new browser profile.
 */

import { strToU8, unzipSync, zipSync } from 'fflate';
import { interleaveChannels, listAssets, loadAsset, saveAsset } from '@/persistence/assets';
import { listProjects, loadProject, saveProject } from '@/persistence/opfs';
import { listFonts, loadFont, saveFont } from '@/project/fonts';

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

/** Reconstructs a Float32Array from interleaved-PCM bytes (alignment-safe). */
function floatsFromPcm(bytes: Uint8Array): Float32Array {
  const copy = bytes.slice();
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
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

function isRestorableAssetMeta(meta: unknown): meta is {
  name: string;
  sampleRate: number;
  numChannels: number;
  tags?: Record<string, unknown>;
} {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return false;
  const value = meta as { name?: unknown; sampleRate?: unknown; numChannels?: unknown };
  return (
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    typeof value.sampleRate === 'number' &&
    Number.isFinite(value.sampleRate) &&
    value.sampleRate > 0 &&
    typeof value.numChannels === 'number' &&
    Number.isInteger(value.numChannels) &&
    value.numChannels > 0
  );
}

function isRestorableFontMeta(meta: unknown): meta is { name: string } {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return false;
  return (
    typeof (meta as { name?: unknown }).name === 'string' &&
    (meta as { name: string }).name.length > 0
  );
}

/**
 * Creates one zip containing all saved projects plus shared OPFS media stores.
 */
export async function createBrowserBackup(savedAt = new Date().toISOString()): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  let projectCount = 0;
  let assetCount = 0;
  let fontCount = 0;

  for (const project of await listProjects()) {
    entries[projectEntryName(project.name)] = await loadProject(project.name);
    projectCount++;
  }

  for (const asset of await listAssets()) {
    try {
      const loaded = await loadAsset(asset.id);
      entries[`${ASSETS_PREFIX}${asset.id}.json`] = strToU8(JSON.stringify(loaded.meta));
      entries[`${ASSETS_PREFIX}${asset.id}.pcm`] = pcmBytes(loaded.channels);
      assetCount++;
    } catch {
      // Keep the archive usable if one shared asset sidecar/payload is broken.
    }
  }

  for (const font of await listFonts()) {
    try {
      entries[`${FONTS_PREFIX}${font.id}.json`] = strToU8(JSON.stringify(font));
      entries[`${FONTS_PREFIX}${font.id}.sf2`] = new Uint8Array(await loadFont(font.id));
      fontCount++;
    } catch {
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
  entries[META_ENTRY] = strToU8(JSON.stringify(meta));
  return zipSync(entries, { mtime: savedAt });
}

/**
 * Restores a browser backup into the OPFS stores, overwriting matching names/ids.
 */
export async function restoreBrowserBackup(bytes: Uint8Array): Promise<BrowserBackupRestoreResult> {
  const entries = unzipSync(bytes);
  const meta = entries[META_ENTRY]
    ? parseJson<Partial<BrowserBackupMeta>>(entries[META_ENTRY])
    : null;
  if (meta?.app !== BACKUP_APP_ID || meta.kind !== BACKUP_KIND || meta.version !== BACKUP_VERSION) {
    throw new Error('Invalid sonare browser backup.');
  }

  const result: BrowserBackupRestoreResult = { projects: 0, assets: 0, fonts: 0 };

  for (const [entryName, data] of Object.entries(entries)) {
    const name = projectNameFromEntry(entryName);
    if (!name) continue;
    await saveProject(name, data);
    result.projects++;
  }

  for (const [entryName, data] of Object.entries(entries)) {
    if (!entryName.startsWith(ASSETS_PREFIX) || !entryName.endsWith('.pcm')) continue;
    const id = entryName.slice(ASSETS_PREFIX.length, -'.pcm'.length);
    if (!MEDIA_ID_PATTERN.test(id)) continue;
    const metaBytes = entries[`${ASSETS_PREFIX}${id}.json`];
    if (!metaBytes) continue;
    if (data.byteLength % 4 !== 0) continue;
    const meta = parseJson<unknown>(metaBytes);
    if (!isRestorableAssetMeta(meta)) continue;
    try {
      await saveAsset(
        {
          id,
          name: meta.name,
          sampleRate: meta.sampleRate,
          numChannels: meta.numChannels,
          ...(meta.tags ? { tags: meta.tags } : {}),
        },
        floatsFromPcm(data),
      );
      result.assets++;
    } catch {
      // Keep restoring the rest of the archive if one media entry is corrupt.
    }
  }

  for (const [entryName, data] of Object.entries(entries)) {
    if (!entryName.startsWith(FONTS_PREFIX) || !entryName.endsWith('.sf2')) continue;
    const id = entryName.slice(FONTS_PREFIX.length, -'.sf2'.length);
    if (!MEDIA_ID_PATTERN.test(id)) continue;
    const metaBytes = entries[`${FONTS_PREFIX}${id}.json`];
    if (!metaBytes) continue;
    const meta = parseJson<unknown>(metaBytes);
    if (!isRestorableFontMeta(meta)) continue;
    try {
      await saveFont({ id, name: meta.name }, data);
      result.fonts++;
    } catch {
      // Keep restoring the rest of the archive if one font entry is corrupt.
    }
  }

  return result;
}
