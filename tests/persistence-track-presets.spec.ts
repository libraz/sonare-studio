import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPersistenceMutationLockForTests } from '@/persistence/mutation-lock';
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
import {
  installMockOpfs,
  type MemoryDirectoryHandle,
  MemoryFileHandle,
  uninstallMockOpfs,
} from './opfs-mock';

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
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');

  beforeEach(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    resetPersistenceMutationLockForTests();
    root = installMockOpfs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPersistenceMutationLockForTests();
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
    else Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
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

  it('serializes concurrent saves so neither preset update is lost', async () => {
    const originalCreateWritable = MemoryFileHandle.prototype.createWritable;
    let releaseFirstWrite!: () => void;
    let firstWriteStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstWriteStarted = resolve;
    });
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let writes = 0;
    vi.spyOn(MemoryFileHandle.prototype, 'createWritable').mockImplementation(async function (
      this: MemoryFileHandle,
    ) {
      const writable = await originalCreateWritable.call(this);
      if (this.name === 'presets.json' && writes++ === 0) {
        firstWriteStarted();
        await firstWriteGate;
      }
      return writable;
    });

    const first = saveTrackChannelPreset(preset('First', -1));
    await firstStarted;
    const second = saveTrackChannelPreset(preset('Second', -2));
    await Promise.resolve();
    releaseFirstWrite();
    await Promise.all([first, second]);

    expect((await listTrackChannelPresets()).map((entry) => entry.name)).toEqual([
      'First',
      'Second',
    ]);
  });

  it('serializes concurrent deletes so neither preset remains', async () => {
    await saveTrackChannelPreset(preset('First'));
    await saveTrackChannelPreset(preset('Second'));
    const originalCreateWritable = MemoryFileHandle.prototype.createWritable;
    let releaseFirstWrite!: () => void;
    let firstWriteStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstWriteStarted = resolve;
    });
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let writes = 0;
    vi.spyOn(MemoryFileHandle.prototype, 'createWritable').mockImplementation(async function (
      this: MemoryFileHandle,
    ) {
      const writable = await originalCreateWritable.call(this);
      if (this.name === 'presets.json' && writes++ === 0) {
        firstWriteStarted();
        await firstWriteGate;
      }
      return writable;
    });

    const removeFirst = deleteTrackChannelPreset('First');
    await firstStarted;
    const removeSecond = deleteTrackChannelPreset('Second');
    await Promise.resolve();
    releaseFirstWrite();
    await Promise.all([removeFirst, removeSecond]);

    expect(await listTrackChannelPresets()).toEqual([]);
  });

  it('requires OPFS storage', async () => {
    uninstallMockOpfs();
    await expect(listTrackChannelPresets()).rejects.toBeInstanceOf(OpfsUnavailableError);
  });
});
