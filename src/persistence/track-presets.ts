/** OPFS persistence for reusable per-track channel presets. */

import {
  normalizeTrackChannelPreset,
  normalizeTrackChannelPresetName,
  type TrackChannelPreset,
} from '@/project/track-preset';
import { isNotFoundError, writeOpfsFile } from './fs-utils';
import { withPersistenceMutationLock } from './mutation-lock';
import { opfsDirectory } from './opfs';

const PRESETS_DIR = 'track-presets';
const PRESETS_FILE = 'presets.json';

function presetsDirectory(): Promise<FileSystemDirectoryHandle> {
  return opfsDirectory(PRESETS_DIR);
}

interface StoredTrackChannelPresets {
  /** Readable presets by display name; a later record of the same name wins. */
  presets: Map<string, TrackChannelPreset>;
  /** Records this build cannot read (for example a newer schema), kept verbatim on rewrite. */
  unreadable: unknown[];
}

async function readTrackChannelPresets(): Promise<StoredTrackChannelPresets> {
  const directory = await presetsDirectory();
  let raw: unknown;
  try {
    const file = await (await directory.getFileHandle(PRESETS_FILE)).getFile();
    raw = JSON.parse(new TextDecoder().decode(await file.arrayBuffer()));
  } catch (error) {
    if (isNotFoundError(error) || error instanceof SyntaxError) {
      return { presets: new Map(), unreadable: [] };
    }
    throw error;
  }
  const stored: StoredTrackChannelPresets = { presets: new Map(), unreadable: [] };
  if (!Array.isArray(raw)) return stored;
  for (const candidate of raw) {
    try {
      const preset = normalizeTrackChannelPreset(candidate);
      stored.presets.set(preset.name, preset);
    } catch {
      // One corrupt/stale preset should not hide every valid saved preset.
      stored.unreadable.push(candidate);
    }
  }
  return stored;
}

/** Lists valid user presets in menu order. Invalid records are ignored, not executed. */
export async function listTrackChannelPresets(): Promise<TrackChannelPreset[]> {
  const { presets } = await readTrackChannelPresets();
  return [...presets.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function writeTrackChannelPresets(stored: StoredTrackChannelPresets): Promise<void> {
  await writeOpfsFile(
    await presetsDirectory(),
    PRESETS_FILE,
    new TextEncoder().encode(JSON.stringify([...stored.unreadable, ...stored.presets.values()])),
  );
}

/** Saves one preset, replacing a previous preset with the same display name. */
export function saveTrackChannelPreset(preset: TrackChannelPreset): Promise<void> {
  return withPersistenceMutationLock(() => saveTrackChannelPresetUnlocked(preset));
}

/** Saves one preset while the caller owns the persistence mutation lock. */
async function saveTrackChannelPresetUnlocked(preset: TrackChannelPreset): Promise<void> {
  const normalized = normalizeTrackChannelPreset(preset);
  const stored = await readTrackChannelPresets();
  stored.presets.delete(normalized.name);
  stored.presets.set(normalized.name, normalized);
  await writeTrackChannelPresets(stored);
}

/** Deletes one named user preset. Missing names are a no-op. */
export function deleteTrackChannelPreset(name: string): Promise<void> {
  return withPersistenceMutationLock(() => deleteTrackChannelPresetUnlocked(name));
}

/** Deletes one preset while the caller owns the persistence mutation lock. */
async function deleteTrackChannelPresetUnlocked(name: string): Promise<void> {
  const normalized = normalizeTrackChannelPresetName(name);
  const stored = await readTrackChannelPresets();
  if (!stored.presets.delete(normalized)) return;
  await writeTrackChannelPresets(stored);
}
