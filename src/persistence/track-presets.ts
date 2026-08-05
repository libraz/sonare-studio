/** OPFS persistence for reusable per-track channel presets. */

import {
  normalizeTrackChannelPreset,
  normalizeTrackChannelPresetName,
  type TrackChannelPreset,
} from '@/project/track-preset';
import { isNotFoundError } from './fs-utils';
import { isOpfsAvailable, OpfsUnavailableError } from './opfs';

const PRESETS_DIR = 'track-presets';
const PRESETS_FILE = 'presets.json';

async function presetsDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!isOpfsAvailable()) throw new OpfsUnavailableError();
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(PRESETS_DIR, { create: true });
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
  const directory = await presetsDirectory();
  const handle = await directory.getFileHandle(PRESETS_FILE, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(new TextEncoder().encode(JSON.stringify(presets)));
    await writable.close();
  } catch (error) {
    try {
      await writable.abort?.();
    } catch {
      // Preserve the actual write error.
    }
    throw error;
  }
}

/** Saves one preset, replacing a previous preset with the same display name. */
export async function saveTrackChannelPreset(preset: TrackChannelPreset): Promise<void> {
  const normalized = normalizeTrackChannelPreset(preset);
  const existing = await listTrackChannelPresets();
  await writeTrackChannelPresets([
    ...existing.filter((entry) => entry.name !== normalized.name),
    normalized,
  ]);
}

/** Deletes one named user preset. Missing names are a no-op. */
export async function deleteTrackChannelPreset(name: string): Promise<void> {
  const normalized = normalizeTrackChannelPresetName(name);
  const existing = await listTrackChannelPresets();
  if (!existing.some((entry) => entry.name === normalized)) return;
  await writeTrackChannelPresets(existing.filter((entry) => entry.name !== normalized));
}
