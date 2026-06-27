import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAudioAssetCache, loadAsset, loadAssetMeta, saveAsset } from '@/persistence/assets';
import {
  collectReferencedAssetIds,
  collectReferencedFontIds,
  gatherProjectBundle,
  restoreProjectBundle,
} from '@/persistence/bundle';
import { clearFontCache, loadFont, loadFontMeta, saveFont } from '@/project/fonts';
import { PROJECT_DOCUMENT_SCHEMA_VERSION, type ProjectDocument } from '@/project/serialization';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

/** A document referencing audio via clip/take/freeze and a SoundFont instrument. */
function makeDocument(): ProjectDocument {
  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name: 'Bundled',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks: [
      {
        name: 'Vox',
        color: '#60a5fa',
        kind: 'audio',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        instrument: { kind: 'sf2', fontId: 'fontA' },
        frozen: { assetId: 'frozen1' },
        clips: [
          {
            name: 'Take',
            startPpq: 0,
            lengthPpq: 4,
            sourceOffsetPpq: 0,
            gain: 1,
            notes: [],
            assetId: 'clip1',
            takes: [{ assetId: 'take1', name: 'T1' }],
          },
        ],
      },
    ],
    markers: [],
    sections: [],
  };
}

function stereo(): Float32Array[] {
  return [new Float32Array([0.1, 0.2, 0.3, 0.4]), new Float32Array([-0.1, -0.2, -0.3, -0.4])];
}

describe('bundle id collection', () => {
  it('collects every referenced asset id (clip, take, freeze)', () => {
    expect([...collectReferencedAssetIds(makeDocument())].sort()).toEqual([
      'clip1',
      'frozen1',
      'take1',
    ]);
  });

  it('collects SoundFont ids from sf2 instruments only', () => {
    expect([...collectReferencedFontIds(makeDocument())]).toEqual(['fontA']);
    const doc = makeDocument();
    doc.tracks[0].instrument = { kind: 'synth-preset', preset: 'saw-lead' };
    expect([...collectReferencedFontIds(doc)]).toEqual([]);
  });
});

describe('bundle gather/restore round-trip', () => {
  beforeEach(() => {
    installMockOpfs();
    clearAudioAssetCache();
    clearFontCache();
  });

  afterEach(() => {
    uninstallMockOpfs();
    clearAudioAssetCache();
    clearFontCache();
  });

  it('gathers referenced media and restores it into a fresh store', async () => {
    // Seed the stores with the referenced media.
    await saveAsset(
      { id: 'clip1', name: 'Clip', sampleRate: 48000, tags: { lufs: -12 } },
      stereo(),
    );
    await saveAsset({ id: 'take1', name: 'Take', sampleRate: 44100 }, stereo());
    await saveAsset({ id: 'frozen1', name: 'Frozen', sampleRate: 48000 }, stereo());
    await saveFont({ id: 'fontA', name: 'Grand' }, new Uint8Array([1, 2, 3, 4, 5]));
    // An unreferenced asset must not be bundled.
    await saveAsset({ id: 'unused', name: 'Unused', sampleRate: 48000 }, stereo());

    const doc = makeDocument();
    const bundle = await gatherProjectBundle(doc);
    expect(bundle.assets.map((a) => a.id).sort()).toEqual(['clip1', 'frozen1', 'take1']);
    expect(bundle.fonts.map((f) => f.id)).toEqual(['fontA']);

    // Simulate importing on a clean machine: wipe the stores, then restore.
    uninstallMockOpfs();
    installMockOpfs();
    clearAudioAssetCache();
    clearFontCache();
    await expect(loadAsset('clip1')).rejects.toThrow();

    await restoreProjectBundle(bundle);

    expect((await loadAsset('clip1')).channels).toEqual(stereo());
    expect((await loadAssetMeta('clip1')).tags).toEqual({ lufs: -12 });
    expect((await loadAsset('take1')).meta.sampleRate).toBe(44100);
    expect((await loadAsset('frozen1')).channels).toEqual(stereo());
    expect(await loadFont('fontA')).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect((await loadFontMeta('fontA')).name).toBe('Grand');
  });

  it('skips media that is not stored rather than failing the export', async () => {
    await saveAsset({ id: 'clip1', name: 'Clip', sampleRate: 48000 }, stereo());
    // take1, frozen1 and fontA are intentionally absent.
    const bundle = await gatherProjectBundle(makeDocument());
    expect(bundle.assets.map((a) => a.id)).toEqual(['clip1']);
    expect(bundle.fonts).toEqual([]);
  });
});
