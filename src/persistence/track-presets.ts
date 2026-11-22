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

/** Lists valid user presets in menu order. Invalid records are ignored, not executed. */
export async function listTrackChannelPresets(): Promise<TrackChannelPreset[]> {
  const directory = await presetsDirectory();
  let raw: unknown;
  try {
    const file = await (await directory.getFileHandle(PRESETS_FILE)).getFile();
    raw = JSON.parse(new TextDecoder().decode(await file.arrayBuffer()));
  } catch (error) {
    if (isNotFoundError(error)) return [];
    if (error instanceof SyntaxError) return [];
    throw error;
  }
  if (!Array.isArray(raw)) return [];
  const byName = new Map<string, TrackChannelPreset>();
  for (const candidate of raw) {
    try {
      const preset = normalizeTrackChannelPreset(candidate);
      byName.set(preset.name, preset);
    } catch {
      // One corrupt/stale preset should not hide every valid saved preset.
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function writeTrackChannelPresets(presets: readonly TrackChannelPreset[]): Promise<void> {
  await writeOpfsFile(
    await presetsDirectory(),
    PRESETS_FILE,
    new TextEncoder().encode(JSON.stringify(presets)),
  );
}

/** Saves one preset, replacing a previous preset with the same display name. */
export function saveTrackChannelPreset(preset: TrackChannelPreset): Promise<void> {
  return withPersistenceMutationLock(() => saveTrackChannelPresetUnlocked(preset));
}

/** Saves one preset while the caller owns the persistence mutation lock. */
async function saveTrackChannelPresetUnlocked(preset: TrackChannelPreset): Promise<void> {
  const normalized = normalizeTrackChannelPreset(preset);
  const existing = await listTrackChannelPresets();
  await writeTrackChannelPresets([
    ...existing.filter((entry) => entry.name !== normalized.name),
    normalized,
  ]);
}

/** Deletes one named user preset. Missing names are a no-op. */
export function deleteTrackChannelPreset(name: string): Promise<void> {
  return withPersistenceMutationLock(() => deleteTrackChannelPresetUnlocked(name));
}

/** Deletes one preset while the caller owns the persistence mutation lock. */
async function deleteTrackChannelPresetUnlocked(name: string): Promise<void> {
  const normalized = normalizeTrackChannelPresetName(name);
  const existing = await listTrackChannelPresets();
  if (!existing.some((entry) => entry.name === normalized)) return;
  await writeTrackChannelPresets(existing.filter((entry) => entry.name !== normalized));
}
