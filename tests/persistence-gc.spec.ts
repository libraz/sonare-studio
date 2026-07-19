import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAudioAssetLeases,
  deleteAudioAssetGuarded,
  isAudioAssetLeased,
  leaseAudioAssets,
  leaseFonts,
} from '@/persistence/asset-leases';
import { clearAudioAssetCache, listAssets, saveAsset } from '@/persistence/assets';
import { collectReferencedMediaIds, garbageCollectMedia } from '@/persistence/gc';
import { saveProject } from '@/persistence/opfs';
import { encodeSzd } from '@/persistence/szd';
import { clearFontCache, listFonts, saveFont } from '@/project/fonts';
import { PROJECT_DOCUMENT_SCHEMA_VERSION, type ProjectDocument } from '@/project/serialization';
import { installMockOpfs, type MemoryDirectoryHandle, uninstallMockOpfs } from './opfs-mock';

/** A document referencing one clip asset and one SoundFont. */
function makeDocument(name: string, assetId: string, fontId: string): ProjectDocument {
  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name,
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
        instrument: { kind: 'sf2', fontId },
        clips: [
          {
            name: 'Clip',
            startPpq: 0,
            lengthPpq: 4,
            sourceOffsetPpq: 0,
            gain: 1,
            notes: [],
            assetId,
          },
        ],
      },
    ],
    markers: [],
    sections: [],
  };
}

function mono(): Float32Array[] {
  return [new Float32Array([0.1, 0.2, 0.3, 0.4])];
}

describe('media garbage collection', () => {
  let root: MemoryDirectoryHandle;

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

  it('collects referenced ids across stored projects and the live document', async () => {
    await saveProject('A', encodeSzd(makeDocument('A', 'storedAsset', 'storedFont')));
    const live = makeDocument('Live', 'liveAsset', 'liveFont');

    const refs = await collectReferencedMediaIds(live);
    expect([...refs.assetIds].sort()).toEqual(['liveAsset', 'storedAsset']);
    expect([...refs.fontIds].sort()).toEqual(['liveFont', 'storedFont']);
    expect(refs.complete).toBe(true);
  });

  it('removes assets and fonts no project references and reports reclaimed bytes', async () => {
    await saveAsset({ id: 'keep', name: 'Keep', sampleRate: 48000 }, mono());
    await saveAsset({ id: 'orphan', name: 'Orphan', sampleRate: 48000 }, mono());
    await saveFont({ id: 'keepFont', name: 'Keep' }, new Uint8Array([1, 2, 3, 4, 5]));
    await saveFont({ id: 'orphanFont', name: 'Orphan' }, new Uint8Array([9, 9, 9]));

    const live = makeDocument('Live', 'keep', 'keepFont');
    const result = await garbageCollectMedia({ liveDocument: live });

    expect(result.incompleteReferences).toBe(false);
    expect(result.removedAssetIds).toEqual(['orphan']);
    expect(result.removedFontIds).toEqual(['orphanFont']);
    // orphan asset: 4 frames * 1 channel * 4 bytes = 16; orphan font: 3 bytes.
    expect(result.reclaimedBytes).toBe(19);

    expect((await listAssets()).map((a) => a.id)).toEqual(['keep']);
    expect((await listFonts()).map((f) => f.id)).toEqual(['keepFont']);
  });

  it('preserves media referenced only by protected undo history ids', async () => {
    await saveAsset({ id: 'undoAsset', name: 'Undo', sampleRate: 48000 }, mono());
    await saveAsset({ id: 'orphan', name: 'Orphan', sampleRate: 48000 }, mono());
    await saveFont({ id: 'undoFont', name: 'Undo' }, new Uint8Array([1, 2, 3]));
    await saveFont({ id: 'orphanFont', name: 'Orphan' }, new Uint8Array([9]));

    const result = await garbageCollectMedia({
      referencedAssetIds: ['undoAsset'],
      referencedFontIds: ['undoFont'],
    });

    expect(result.removedAssetIds).toEqual(['orphan']);
    expect(result.removedFontIds).toEqual(['orphanFont']);
    expect((await listAssets()).map((a) => a.id)).toEqual(['undoAsset']);
    expect((await listFonts()).map((f) => f.id)).toEqual(['undoFont']);
  });

  it('preserves every editor history version while its shared lease is open', async () => {
    await saveAsset({ id: 'source', name: 'Source', sampleRate: 48000 }, mono());
    await saveAsset({ id: 'undo-version', name: 'Undo', sampleRate: 48000 }, mono());
    const historyLease = leaseAudioAssets(['source', 'undo-version']);

    expect((await garbageCollectMedia()).removedAssetIds).toEqual([]);
    expect((await listAssets()).map((a) => a.id).sort()).toEqual(['source', 'undo-version']);

    historyLease.release();
    expect((await garbageCollectMedia()).removedAssetIds).toEqual(['source', 'undo-version']);
  });

  it('preserves a leased SoundFont no stored project references', async () => {
    // A font another tab's live document references (but that no .szd holds yet)
    // must survive GC. The lease stands in for that live cross-tab reference.
    await saveFont({ id: 'liveOnlyFont', name: 'Live' }, new Uint8Array([1, 2, 3]));
    const fontLease = leaseFonts(['liveOnlyFont']);

    expect((await garbageCollectMedia()).removedFontIds).toEqual([]);
    expect((await listFonts()).map((f) => f.id)).toEqual(['liveOnlyFont']);

    fontLease.release();
    expect((await garbageCollectMedia()).removedFontIds).toEqual(['liveOnlyFont']);
    expect(await listFonts()).toEqual([]);
  });

  it('keeps a just-saved output leased from id resolution through project commit', async () => {
    let outputLease: ReturnType<typeof leaseAudioAssets> | undefined;
    const meta = await saveAsset(
      {
        name: 'Edit',
        sampleRate: 48000,
        onIdResolved: (assetId) => {
          outputLease = leaseAudioAssets([assetId]);
        },
      },
      mono(),
    );

    expect(outputLease).toBeDefined();
    expect(isAudioAssetLeased(meta.id)).toBe(true);
    expect((await garbageCollectMedia()).removedAssetIds).toEqual([]);

    outputLease?.release();
    expect((await garbageCollectMedia()).removedAssetIds).toEqual([meta.id]);
  });

  it('rechecks a placement lease immediately before a confirmed deletion', async () => {
    await saveAsset({ id: 'placed', name: 'Placed', sampleRate: 48000 }, mono());
    let finishReferenceScan!: (referenced: boolean) => void;
    const referenceScan = new Promise<boolean>((resolve) => {
      finishReferenceScan = resolve;
    });
    const deleting = deleteAudioAssetGuarded('placed', () => referenceScan);

    // The exclusive delete guard prevents a new placement from racing between
    // reference validation and the OPFS mutation.
    expect(() => leaseAudioAssets(['placed'])).toThrow(/being deleted/);
    finishReferenceScan(false);
    expect(await deleting).toBe(true);
    expect((await listAssets()).map((a) => a.id)).toEqual([]);
  });

  it('preserves media held only by an unbundled autosave slot', async () => {
    await saveAsset({ id: 'slotAsset', name: 'Slot', sampleRate: 48000 }, mono());
    await saveFont({ id: 'slotFont', name: 'Slot' }, new Uint8Array([1, 2, 3]));
    // The autosave slot writes its .szd without a media bundle, so the shared
    // store is the only place this media lives.
    await saveProject('__autosave__', encodeSzd(makeDocument('Auto', 'slotAsset', 'slotFont')));

    const result = await garbageCollectMedia();

    expect(result.removedAssetIds).toEqual([]);
    expect(result.removedFontIds).toEqual([]);
    expect((await listAssets()).map((a) => a.id)).toEqual(['slotAsset']);
    expect((await listFonts()).map((f) => f.id)).toEqual(['slotFont']);
  });

  it('does not delete when a dry run is requested', async () => {
    await saveAsset({ id: 'orphan', name: 'Orphan', sampleRate: 48000 }, mono());

    const result = await garbageCollectMedia({ dryRun: true });

    expect(result.removedAssetIds).toEqual(['orphan']);
    expect(result.reclaimedBytes).toBe(16);
    expect((await listAssets()).map((a) => a.id)).toEqual(['orphan']);
  });

  it('removes orphan PCM payloads that have no metadata sidecar', async () => {
    const assetsDir = await root.getDirectoryHandle('assets', { create: true });
    assetsDir.files.set('crash-leftover.pcm', {
      data: new Uint8Array([1, 2, 3, 4, 5, 6]),
      lastModified: 1,
    });

    const result = await garbageCollectMedia();

    expect(result.removedAssetIds).toEqual(['crash-leftover']);
    expect(result.reclaimedBytes).toBe(6);
    expect(assetsDir.files.has('crash-leftover.pcm')).toBe(false);
  });

  it('deletes nothing when a stored project cannot be decoded', async () => {
    await saveAsset({ id: 'orphan', name: 'Orphan', sampleRate: 48000 }, mono());
    // A corrupt .szd leaves its references unknown.
    await saveProject('Broken', new Uint8Array([0, 1, 2, 3]));

    const result = await garbageCollectMedia();

    expect(result.incompleteReferences).toBe(true);
    expect(result.removedAssetIds).toEqual([]);
    expect((await listAssets()).map((a) => a.id)).toEqual(['orphan']);
  });
});
