import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetPersistenceMutationLockForTests } from '@/persistence/mutation-lock';
import { deleteTrackChannelPreset, saveTrackChannelPreset } from '@/persistence/track-presets';
import { createDefaultStrip } from '@/project/mixer';
import {
  TRACK_CHANNEL_PRESET_SCHEMA_VERSION,
  type TrackChannelPreset,
} from '@/project/track-preset';
import { installMockOpfs, type MemoryDirectoryHandle, uninstallMockOpfs } from './opfs-mock';

function preset(name: string): TrackChannelPreset {
  return {
    schemaVersion: TRACK_CHANNEL_PRESET_SCHEMA_VERSION,
    name,
    strip: createDefaultStrip(),
    instrument: { kind: 'synth-preset', preset: 'warmPad' },
  };
}

/** A record written by a newer schema this build cannot read. */
const FUTURE = { schemaVersion: 999, name: 'From a newer build', strip: {} };

describe('track preset records this build cannot read', () => {
  let root: MemoryDirectoryHandle;
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');

  beforeEach(async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    resetPersistenceMutationLockForTests();
    root = installMockOpfs();
    const directory = await root.getDirectoryHandle('track-presets', { create: true });
    directory.files.set('presets.json', {
      data: new TextEncoder().encode(JSON.stringify([preset('Keep'), FUTURE])),
      lastModified: 1,
    });
  });

  afterEach(() => {
    resetPersistenceMutationLockForTests();
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
    uninstallMockOpfs();
  });

  async function storedRecords(): Promise<unknown[]> {
    const directory = await root.getDirectoryHandle('track-presets');
    const entry = directory.files.get('presets.json');
    return JSON.parse(new TextDecoder().decode(entry?.data));
  }

  it('keeps them when another preset is saved', async () => {
    await saveTrackChannelPreset(preset('New'));
    expect(await storedRecords()).toContainEqual(FUTURE);
  });

  it('keeps them when another preset is deleted', async () => {
    await deleteTrackChannelPreset('Keep');
    expect(await storedRecords()).toEqual([FUTURE]);
  });
});
