import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  audioAssetCacheStats,
  clearAudioAssetCache,
  interleaveChannels,
  readAssetPcmBytes,
  saveAsset,
} from '@/persistence/assets';
import {
  gatherProjectBundle,
  MediaRestoreConflictError,
  preflightAssetRestore,
  prepareAssetRestore,
} from '@/persistence/bundle';
import { PROJECT_DOCUMENT_SCHEMA_VERSION, type ProjectDocument } from '@/project/serialization';
import { documentClip } from './fakes/project';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

function documentReferencing(assetId: string): ProjectDocument {
  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name: 'Pcm',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks: [
      {
        name: 'Audio',
        color: '#60a5fa',
        kind: 'audio',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        clips: [
          documentClip({
            name: 'Clip',
            startPpq: 0,
            lengthPpq: 4,
            sourceOffsetPpq: 0,
            gain: 1,
            notes: [],
            assetId,
          }),
        ],
      },
    ],
    markers: [],
    sections: [],
  };
}

const stereo = (): Float32Array[] => [
  new Float32Array([0.1, 0.2, 0.3]),
  new Float32Array([-1, -2, -3]),
];

describe('asset PCM byte reads', () => {
  beforeEach(() => {
    installMockOpfs();
    clearAudioAssetCache();
  });

  afterEach(() => {
    clearAudioAssetCache();
    uninstallMockOpfs();
  });

  it('returns the stored interleaved bytes without populating the decoded cache', async () => {
    const meta = await saveAsset({ name: 'Stereo', sampleRate: 48000 }, stereo());
    clearAudioAssetCache();

    const read = await readAssetPcmBytes(meta.id);

    const expected = interleaveChannels(stereo());
    expect(read.meta).toEqual(meta);
    expect(
      Array.from(new Float32Array(read.pcm.buffer, read.pcm.byteOffset, expected.length)),
    ).toEqual(Array.from(expected));
    expect(audioAssetCacheStats().entries).toBe(0);
  });

  it('gathers bundle PCM without decoding it into the playback cache', async () => {
    const meta = await saveAsset({ name: 'Stereo', sampleRate: 48000 }, stereo());
    clearAudioAssetCache();

    const bundle = await gatherProjectBundle(documentReferencing(meta.id));

    expect(bundle.assets).toHaveLength(1);
    expect(bundle.assets[0].pcm.byteLength).toBe(3 * 2 * 4);
    expect(audioAssetCacheStats().entries).toBe(0);
  });

  it('preflights a restore against stored bytes without decoding them', async () => {
    const meta = await saveAsset({ name: 'Stereo', sampleRate: 48000 }, stereo());
    clearAudioAssetCache();
    const { bundle } = { bundle: await gatherProjectBundle(documentReferencing(meta.id)) };
    clearAudioAssetCache();
    const entry = prepareAssetRestore(bundle.assets[0]);

    await expect(preflightAssetRestore(entry)).resolves.toBe(true);
    expect(audioAssetCacheStats().entries).toBe(0);

    const changed = new Uint8Array(entry.pcm);
    changed[0] ^= 0xff;
    await expect(preflightAssetRestore({ ...entry, pcm: changed })).rejects.toBeInstanceOf(
      MediaRestoreConflictError,
    );
  });
});
