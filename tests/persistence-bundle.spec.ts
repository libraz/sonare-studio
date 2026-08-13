import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAudioAssetLeases,
  isAudioAssetLeased,
  isFontLeased,
} from '@/persistence/asset-leases';
import {
  clearAudioAssetCache,
  computeAssetId,
  loadAsset,
  loadAssetMeta,
  saveAsset,
} from '@/persistence/assets';
import {
  collectReferencedAssetIds,
  collectReferencedFontIds,
  gatherProjectBundle,
  gatherProjectBundleWithReport,
  prepareAssetRestore,
  restoreProjectBundle,
} from '@/persistence/bundle';
import { garbageCollectMedia } from '@/persistence/gc';
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

/** A minimal RIFF/sfbk prefix; payload contents are irrelevant to bundle tests. */
function sf2(...payload: number[]): Uint8Array {
  return new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x73, 0x66, 0x62, 0x6b, ...payload]);
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

describe('bundled audio resource limits', () => {
  it('rejects zero-frame payloads before channel allocation', () => {
    expect(() =>
      prepareAssetRestore({
        id: 'empty',
        meta: new TextEncoder().encode(
          JSON.stringify({
            id: 'empty',
            name: 'Empty',
            sampleRate: 48000,
            numChannels: 1_000_000_000,
            numFrames: 0,
          }),
        ),
        pcm: new Uint8Array(0),
      }),
    ).toThrow(/PCM payload size/);
  });

  it('rejects impractical sample rates and channel counts', () => {
    const pcm = new Uint8Array(new Float32Array([0]).buffer);
    for (const meta of [
      { sampleRate: 384001, numChannels: 1 },
      { sampleRate: 48000, numChannels: 33 },
    ]) {
      expect(() =>
        prepareAssetRestore({
          id: 'bounded',
          meta: new TextEncoder().encode(
            JSON.stringify({ id: 'bounded', name: 'Bounded', numFrames: 1, ...meta }),
          ),
          pcm,
        }),
      ).toThrow(/malformed metadata/);
    }
  });
});

describe('bundle gather/restore round-trip', () => {
  let root: ReturnType<typeof installMockOpfs>;

  beforeEach(() => {
    root = installMockOpfs();
    clearAudioAssetCache();
    clearFontCache();
    clearAudioAssetLeases();
  });

  afterEach(() => {
    uninstallMockOpfs();
    clearAudioAssetCache();
    clearFontCache();
    clearAudioAssetLeases();
  });

  it('gathers referenced media and restores it into a fresh store', async () => {
    // Seed the stores with the referenced media.
    await saveAsset(
      { id: 'clip1', name: 'Clip', sampleRate: 48000, tags: { lufs: -12 } },
      stereo(),
    );
    await saveAsset({ id: 'take1', name: 'Take', sampleRate: 44100 }, stereo());
    await saveAsset({ id: 'frozen1', name: 'Frozen', sampleRate: 48000 }, stereo());
    await saveFont({ id: 'fontA', name: 'Grand' }, sf2(1, 2, 3, 4, 5));
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

    const restoreLease = await restoreProjectBundle(doc, bundle);

    try {
      expect((await loadAsset('clip1')).channels).toEqual(stereo());
      expect((await loadAssetMeta('clip1')).tags).toEqual({ lufs: -12 });
      expect((await loadAsset('take1')).meta.sampleRate).toBe(44100);
      expect((await loadAsset('frozen1')).channels).toEqual(stereo());
      expect(await loadFont('fontA')).toEqual(sf2(1, 2, 3, 4, 5));
      expect((await loadFontMeta('fontA')).name).toBe('Grand');
    } finally {
      restoreLease.release();
    }
  });

  it('skips media that is not stored rather than failing the export', async () => {
    await saveAsset({ id: 'clip1', name: 'Clip', sampleRate: 48000 }, stereo());
    // take1, frozen1 and fontA are intentionally absent.
    const gathered = await gatherProjectBundleWithReport(makeDocument());
    expect(gathered.bundle.assets.map((a) => a.id)).toEqual(['clip1']);
    expect(gathered.bundle.fonts).toEqual([]);
    expect(gathered.report.complete).toBe(false);
    expect(gathered.report.issues.map((issue) => [issue.mediaId, issue.role])).toEqual(
      expect.arrayContaining([
        ['take1', 'take'],
        ['frozen1', 'frozen'],
        ['fontA', 'instrument'],
      ]),
    );
  });

  it('ignores unreferenced archive media without decoding or storing it', async () => {
    const doc = makeDocument();
    doc.tracks[0].clips = [];
    doc.tracks[0].frozen = undefined;
    doc.tracks[0].instrument = undefined;

    const restoreLease = await restoreProjectBundle(doc, {
      assets: [
        {
          id: 'unreferenced',
          meta: new TextEncoder().encode('{not json'),
          pcm: new Uint8Array([1, 2, 3]),
        },
      ],
      fonts: [],
    });
    restoreLease.release();

    await expect(loadAsset('unreferenced')).rejects.toThrow();
  });

  it('preflights every referenced id and never overwrites conflicting shared media', async () => {
    await saveAsset({ id: 'clip1', name: 'Existing', sampleRate: 48000 }, stereo());
    const conflicting = [new Float32Array([0.9]), new Float32Array([-0.9])];
    const interleaved = new Float32Array([0.9, -0.9]);
    const bundle = {
      assets: [
        {
          id: 'clip1',
          meta: new TextEncoder().encode(
            JSON.stringify({
              id: 'clip1',
              name: 'Conflict',
              sampleRate: 48000,
              numChannels: 2,
              numFrames: 1,
            }),
          ),
          pcm: new Uint8Array(interleaved.buffer).slice(),
        },
      ],
      fonts: [],
    };
    const doc = makeDocument();
    doc.tracks[0].clips[0].takes = [];
    doc.tracks[0].frozen = undefined;
    doc.tracks[0].instrument = undefined;

    await expect(restoreProjectBundle(doc, bundle)).rejects.toThrow('conflicts');
    expect((await loadAsset('clip1')).channels).toEqual(stereo());
    expect((await loadAsset('clip1')).channels).not.toEqual(conflicting);
  });

  it('rejects a hash-shaped asset id whose payload does not match', async () => {
    const audio = new Float32Array([0.25]);
    const actualId = computeAssetId(audio, 48000, 1);
    const forgedId = actualId === '0000000000000000' ? '1111111111111111' : '0000000000000000';
    const doc = makeDocument();
    doc.tracks[0].clips = [
      {
        ...doc.tracks[0].clips[0],
        assetId: forgedId,
        takes: [],
      },
    ];
    doc.tracks[0].frozen = undefined;
    doc.tracks[0].instrument = undefined;

    await expect(
      restoreProjectBundle(doc, {
        assets: [
          {
            id: forgedId,
            meta: new TextEncoder().encode(
              JSON.stringify({
                id: forgedId,
                name: 'Forged',
                sampleRate: 48000,
                numChannels: 1,
                numFrames: 1,
              }),
            ),
            pcm: new Uint8Array(audio.buffer).slice(),
          },
        ],
        fonts: [],
      }),
    ).rejects.toThrow('does not match its content id');
  });

  it('preflights font conflicts before committing an otherwise new audio asset', async () => {
    const existingFont = sf2(1, 2, 3);
    await saveFont({ id: 'fontA', name: 'Existing font' }, existingFont);
    const audio = new Float32Array([0.25]);
    const doc = makeDocument();
    doc.tracks[0].clips[0].takes = [];
    doc.tracks[0].frozen = undefined;

    await expect(
      restoreProjectBundle(doc, {
        assets: [
          {
            id: 'clip1',
            meta: new TextEncoder().encode(
              JSON.stringify({
                id: 'clip1',
                name: 'New audio',
                sampleRate: 48000,
                numChannels: 1,
                numFrames: 1,
              }),
            ),
            pcm: new Uint8Array(audio.buffer).slice(),
          },
        ],
        fonts: [
          {
            id: 'fontA',
            meta: new TextEncoder().encode(
              JSON.stringify({
                id: 'fontA',
                name: 'Conflict',
                byteLength: sf2(9, 9, 9).byteLength,
              }),
            ),
            sf2: sf2(9, 9, 9),
          },
        ],
      }),
    ).rejects.toThrow('conflicts');

    await expect(loadAsset('clip1')).rejects.toThrow();
    expect(await loadFont('fontA')).toEqual(existingFont);
  });

  it('keeps restored media leased until the importing caller commits it', async () => {
    const doc = makeDocument();
    doc.tracks[0].clips[0].takes = [];
    doc.tracks[0].frozen = undefined;
    const restoreLease = await restoreProjectBundle(doc, {
      assets: [
        {
          id: 'clip1',
          meta: new TextEncoder().encode(
            JSON.stringify({
              id: 'clip1',
              name: 'Imported',
              sampleRate: 48000,
              numChannels: 2,
              numFrames: 4,
            }),
          ),
          pcm: new Uint8Array(
            new Float32Array([0.1, -0.1, 0.2, -0.2, 0.3, -0.3, 0.4, -0.4]).buffer,
          ).slice(),
        },
      ],
      fonts: [
        {
          id: 'fontA',
          meta: new TextEncoder().encode(
            JSON.stringify({
              id: 'fontA',
              name: 'Imported font',
              byteLength: sf2(1, 2, 3, 4).byteLength,
            }),
          ),
          sf2: sf2(1, 2, 3, 4),
        },
      ],
    });

    expect(isAudioAssetLeased('clip1')).toBe(true);
    expect(isFontLeased('fontA')).toBe(true);
    await expect(garbageCollectMedia()).resolves.toMatchObject({
      removedAssetIds: [],
      removedFontIds: [],
    });

    restoreLease.release();
    expect(isAudioAssetLeased('clip1')).toBe(false);
    expect(isFontLeased('fontA')).toBe(false);
    await expect(garbageCollectMedia()).resolves.toMatchObject({
      removedAssetIds: ['clip1'],
      removedFontIds: ['fontA'],
    });
  });

  it('rolls back created media through the returned protected lease', async () => {
    const doc = makeDocument();
    doc.tracks[0].clips[0].takes = [];
    doc.tracks[0].frozen = undefined;
    const restoreLease = await restoreProjectBundle(doc, {
      assets: [
        {
          id: 'clip1',
          meta: new TextEncoder().encode(
            JSON.stringify({
              id: 'clip1',
              name: 'Imported',
              sampleRate: 48000,
              numChannels: 2,
              numFrames: 4,
            }),
          ),
          pcm: new Uint8Array(
            new Float32Array([0.1, -0.1, 0.2, -0.2, 0.3, -0.3, 0.4, -0.4]).buffer,
          ).slice(),
        },
      ],
      fonts: [],
    });

    await restoreLease.rollback();

    await expect(loadAsset('clip1')).rejects.toThrow();
    expect(isAudioAssetLeased('clip1')).toBe(false);
  });

  it('cleans newly-created media on restore failure before releasing its lease', async () => {
    const doc = makeDocument();
    doc.tracks[0].clips[0].takes = [];
    doc.tracks[0].frozen = undefined;
    const fonts = await root.getDirectoryHandle('fonts', { create: true });
    const originalGetFileHandle = fonts.getFileHandle.bind(fonts);
    fonts.getFileHandle = async (name, options) => {
      const handle = await originalGetFileHandle(name, options);
      if (name === 'fontA.json') {
        handle.createWritable = async () => {
          throw new Error('injected SoundFont publish failure');
        };
      }
      return handle;
    };

    await expect(
      restoreProjectBundle(doc, {
        assets: [
          {
            id: 'clip1',
            meta: new TextEncoder().encode(
              JSON.stringify({
                id: 'clip1',
                name: 'Imported',
                sampleRate: 48000,
                numChannels: 2,
                numFrames: 4,
              }),
            ),
            pcm: new Uint8Array(
              new Float32Array([0.1, -0.1, 0.2, -0.2, 0.3, -0.3, 0.4, -0.4]).buffer,
            ).slice(),
          },
        ],
        fonts: [
          {
            id: 'fontA',
            meta: new TextEncoder().encode(
              JSON.stringify({
                id: 'fontA',
                name: 'Imported font',
                byteLength: sf2(1, 2, 3, 4).byteLength,
              }),
            ),
            sf2: sf2(1, 2, 3, 4),
          },
        ],
      }),
    ).rejects.toThrow('injected SoundFont publish failure');

    await expect(loadAsset('clip1')).rejects.toThrow();
    await expect(loadFont('fontA')).rejects.toThrow();
    expect(isAudioAssetLeased('clip1')).toBe(false);
    expect(isFontLeased('fontA')).toBe(false);
  });
});
