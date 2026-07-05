import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAudioAssetCache, loadAsset, loadAssetMeta, saveAsset } from '@/persistence/assets';
import { createBrowserBackup, restoreBrowserBackup } from '@/persistence/backup';
import { loadProject, saveProject } from '@/persistence/opfs';
import { encodeSzd } from '@/persistence/szd';
import { clearFontCache, loadFont, loadFontMeta, saveFont } from '@/project/fonts';
import { PROJECT_DOCUMENT_SCHEMA_VERSION, type ProjectDocument } from '@/project/serialization';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

function makeDocument(name: string): ProjectDocument {
  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name,
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks: [],
    markers: [],
    sections: [],
  };
}

function stereo(): Float32Array[] {
  return [new Float32Array([0.1, 0.2]), new Float32Array([-0.1, -0.2])];
}

describe('browser backup archives', () => {
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

  it('backs up and restores all projects, shared audio assets, and SoundFonts', async () => {
    const projectBytes = encodeSzd(makeDocument('Song A'));
    await saveProject('Song A', projectBytes);
    await saveAsset(
      { id: 'assetA', name: 'Shared audio', sampleRate: 48000, tags: { bpm: 124 } },
      stereo(),
    );
    await saveFont({ id: 'fontA', name: 'Shared font' }, new Uint8Array([1, 2, 3, 4]));

    const backup = await createBrowserBackup('2026-07-04T00:00:00.000Z');

    uninstallMockOpfs();
    installMockOpfs();
    clearAudioAssetCache();
    clearFontCache();

    const restored = await restoreBrowserBackup(backup);

    expect(restored).toEqual({ projects: 1, assets: 1, fonts: 1 });
    expect(await loadProject('Song A')).toEqual(projectBytes);
    expect((await loadAsset('assetA')).channels).toEqual(stereo());
    expect((await loadAssetMeta('assetA')).tags).toEqual({ bpm: 124 });
    expect(await loadFont('fontA')).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect((await loadFontMeta('fontA')).name).toBe('Shared font');
  });

  it('rejects archives without sonare browser-backup metadata', async () => {
    await expect(restoreBrowserBackup(encodeSzd(makeDocument('Not a backup')))).rejects.toThrow(
      'Invalid sonare browser backup.',
    );
  });

  it('skips malformed media entries while restoring the rest of the backup', async () => {
    const projectBytes = encodeSzd(makeDocument('Song A'));
    const validPcm = new Uint8Array(stereo()[0].buffer).slice();
    const backup = zipSync({
      'meta.json': strToU8(
        JSON.stringify({
          app: 'sonare-studio',
          kind: 'browser-backup',
          version: 1,
          savedAt: '2026-07-04T00:00:00.000Z',
          projects: 1,
          assets: 1,
          fonts: 1,
        }),
      ),
      'projects/Song%20A.szd': projectBytes,
      'assets/good.json': strToU8(
        JSON.stringify({ name: 'Good audio', sampleRate: 48000, numChannels: 1 }),
      ),
      'assets/good.pcm': validPcm,
      'assets/bad-meta.json': strToU8(JSON.stringify({ name: '', sampleRate: 48000 })),
      'assets/bad-meta.pcm': validPcm,
      'assets/bad-pcm.json': strToU8(
        JSON.stringify({ name: 'Bad PCM', sampleRate: 48000, numChannels: 1 }),
      ),
      'assets/bad-pcm.pcm': new Uint8Array([1, 2, 3]),
      'fonts/goodFont.json': strToU8(JSON.stringify({ name: 'Good font' })),
      'fonts/goodFont.sf2': new Uint8Array([1, 2, 3]),
      'fonts/badFont.json': strToU8(JSON.stringify({ name: '' })),
      'fonts/badFont.sf2': new Uint8Array([4, 5, 6]),
    });

    const restored = await restoreBrowserBackup(backup);

    expect(restored).toEqual({ projects: 1, assets: 1, fonts: 1 });
    expect(await loadProject('Song A')).toEqual(projectBytes);
    expect((await loadAssetMeta('good')).name).toBe('Good audio');
    expect(await loadFont('goodFont')).toEqual(new Uint8Array([1, 2, 3]));
    await expect(loadAsset('bad-meta')).rejects.toThrow();
    await expect(loadAsset('bad-pcm')).rejects.toThrow();
    await expect(loadFont('badFont')).rejects.toThrow();
  });
});
