import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpfsUnavailableError } from '@/persistence/opfs';
import {
  deleteTrackChannelPreset,
  listTrackChannelPresets,
  saveTrackChannelPreset,
} from '@/persistence/track-presets';
import { createDefaultStrip } from '@/project/mixer';
import {
  TRACK_CHANNEL_PRESET_SCHEMA_VERSION,
  type TrackChannelPreset,
} from '@/project/track-preset';
import { installMockOpfs, type MemoryDirectoryHandle, uninstallMockOpfs } from './opfs-mock';

function preset(name: string, gainDb = 0): TrackChannelPreset {
  return {
    schemaVersion: TRACK_CHANNEL_PRESET_SCHEMA_VERSION,
    name,
    strip: { ...createDefaultStrip(), gainDb },
    instrument: { kind: 'synth-preset', preset: 'warm-pad' },
  };
}

describe('track preset OPFS persistence', () => {
  let root: MemoryDirectoryHandle;

  beforeEach(() => {
    root = installMockOpfs();
  });

  afterEach(() => {
    uninstallMockOpfs();
  });

  it('saves, replaces, lists and deletes named presets', async () => {
    await saveTrackChannelPreset(preset('Pads', -3));
    await saveTrackChannelPreset(preset('Drums', 2));
    await saveTrackChannelPreset(preset('Pads', -6));

    expect(await listTrackChannelPresets()).toMatchObject([
      { name: 'Drums', strip: { gainDb: 2 } },
      { name: 'Pads', strip: { gainDb: -6 } },
    ]);
    expect((await root.getDirectoryHandle('track-presets')).files.has('presets.json')).toBe(true);

    await deleteTrackChannelPreset('Pads');
    expect((await listTrackChannelPresets()).map((entry) => entry.name)).toEqual(['Drums']);
    await deleteTrackChannelPreset('Missing');
  });

  it('ignores malformed records without hiding valid presets', async () => {
    const directory = await root.getDirectoryHandle('track-presets', { create: true });
    directory.files.set('presets.json', {
      data: new TextEncoder().encode(JSON.stringify([preset('Good'), { schemaVersion: 999 }])),
      lastModified: 1,
    });
    expect((await listTrackChannelPresets()).map((entry) => entry.name)).toEqual(['Good']);
  });

  it('requires OPFS storage', async () => {
    uninstallMockOpfs();
    await expect(listTrackChannelPresets()).rejects.toBeInstanceOf(OpfsUnavailableError);
  });
});
