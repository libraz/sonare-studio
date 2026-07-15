import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAudioAssetCache, loadAsset, loadAssetMeta, saveAsset } from '@/persistence/assets';
import { createBrowserBackup, restoreBrowserBackup } from '@/persistence/backup';
import { loadProject, saveProject } from '@/persistence/opfs';
import { encodeSzd } from '@/persistence/szd';
import { clearFontCache, loadFont, loadFontMeta, saveFont } from '@/project/fonts';
import { PROJECT_DOCUMENT_SCHEMA_VERSION, type ProjectDocument } from '@/project/serialization';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

function makeDocument(
  name: string,
  refs: { assetId?: string; fontId?: string } = {},
): ProjectDocument {
  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name,
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks:
      refs.assetId || refs.fontId
        ? [
            {
              name: 'Media',
              color: '#60a5fa',
              kind: 'audio',
              mute: false,
              solo: false,
              volume: 1,
              pan: 0,
              ...(refs.fontId ? { instrument: { kind: 'sf2' as const, fontId: refs.fontId } } : {}),
              clips: refs.assetId
                ? [
                    {
                      name: 'Audio',
                      startPpq: 0,
                      lengthPpq: 4,
                      sourceOffsetPpq: 0,
                      gain: 1,
                      notes: [],
                      assetId: refs.assetId,
                    },
                  ]
                : [],
            },
          ]
        : [],
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
    const projectBytes = encodeSzd(makeDocument('Song A', { assetId: 'assetA', fontId: 'fontA' }));
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
    const projectBytes = encodeSzd(makeDocument('Song A', { assetId: 'good', fontId: 'goodFont' }));
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
        JSON.stringify({
          id: 'good',
          name: 'Good audio',
          sampleRate: 48000,
          numChannels: 1,
          numFrames: validPcm.byteLength / 4,
        }),
      ),
      'assets/good.pcm': validPcm,
      'assets/bad-meta.json': strToU8(JSON.stringify({ name: '', sampleRate: 48000 })),
      'assets/bad-meta.pcm': validPcm,
      'assets/bad-pcm.json': strToU8(
        JSON.stringify({ name: 'Bad PCM', sampleRate: 48000, numChannels: 1 }),
      ),
      'assets/bad-pcm.pcm': new Uint8Array([1, 2, 3]),
      'fonts/goodFont.json': strToU8(
        JSON.stringify({ id: 'goodFont', name: 'Good font', byteLength: 3 }),
      ),
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

  it('rejects media id conflicts before overwriting projects or shared content', async () => {
    const existingProject = encodeSzd(makeDocument('Existing'));
    await saveProject('Song A', existingProject);
    await saveAsset({ id: 'assetA', name: 'Existing audio', sampleRate: 48000 }, [
      new Float32Array([0.9]),
    ]);
    const incomingAudio = new Float32Array([0.1]);
    const incomingProject = encodeSzd(makeDocument('Song A', { assetId: 'assetA' }));
    const backup = zipSync({
      'meta.json': strToU8(
        JSON.stringify({
          app: 'sonare-studio',
          kind: 'browser-backup',
          version: 1,
          savedAt: '2026-07-15T00:00:00.000Z',
          projects: 1,
          assets: 1,
          fonts: 0,
        }),
      ),
      'projects/Song%20A.szd': incomingProject,
      'assets/assetA.json': strToU8(
        JSON.stringify({
          id: 'assetA',
          name: 'Incoming audio',
          sampleRate: 48000,
          numChannels: 1,
          numFrames: 1,
        }),
      ),
      'assets/assetA.pcm': new Uint8Array(incomingAudio.buffer).slice(),
    });

    await expect(restoreBrowserBackup(backup)).rejects.toThrow('conflicts');
    expect(await loadProject('Song A')).toEqual(existingProject);
    expect((await loadAsset('assetA')).channels[0]).toEqual(new Float32Array([0.9]));
  });

  it('rejects project names that collide after filesystem sanitization', async () => {
    const backup = zipSync({
      'meta.json': strToU8(
        JSON.stringify({
          app: 'sonare-studio',
          kind: 'browser-backup',
          version: 1,
          savedAt: '2026-07-15T00:00:00.000Z',
          projects: 2,
          assets: 0,
          fonts: 0,
        }),
      ),
      'projects/A%3AB.szd': encodeSzd(makeDocument('A:B')),
      'projects/A%3FB.szd': encodeSzd(makeDocument('A?B')),
    });

    await expect(restoreBrowserBackup(backup)).rejects.toThrow('colliding project name');
    await expect(loadProject('A_B')).rejects.toThrow();
  });

  it('rolls back newly restored media when a project write runs out of quota', async () => {
    const root = installMockOpfs();
    clearAudioAssetCache();
    const projectDir = await root.getDirectoryHandle('projects', { create: true });
    const originalGetFileHandle = projectDir.getFileHandle.bind(projectDir);
    let failOnce = true;
    vi.spyOn(projectDir, 'getFileHandle').mockImplementation(async (name, options) => {
      const handle = await originalGetFileHandle(name, options);
      if (name !== 'Song A.szd' || !failOnce) return handle;
      return {
        ...handle,
        createWritable: async () =>
          ({
            write: async () => {
              failOnce = false;
              const error = new Error('quota');
              error.name = 'QuotaExceededError';
              throw error;
            },
            close: async () => {},
          }) as unknown as FileSystemWritableFileStream,
      } as unknown as typeof handle;
    });

    const audio = new Float32Array([0.1]);
    const backup = zipSync({
      'meta.json': strToU8(
        JSON.stringify({
          app: 'sonare-studio',
          kind: 'browser-backup',
          version: 1,
          savedAt: '2026-07-15T00:00:00.000Z',
          projects: 1,
          assets: 1,
          fonts: 0,
        }),
      ),
      'projects/Song%20A.szd': encodeSzd(makeDocument('Song A', { assetId: 'newAsset' })),
      'assets/newAsset.json': strToU8(
        JSON.stringify({
          id: 'newAsset',
          name: 'New audio',
          sampleRate: 48000,
          numChannels: 1,
          numFrames: 1,
        }),
      ),
      'assets/newAsset.pcm': new Uint8Array(audio.buffer).slice(),
    });

    await expect(restoreBrowserBackup(backup)).rejects.toThrow('quota');
    await expect(loadProject('Song A')).rejects.toThrow();
    await expect(loadAsset('newAsset')).rejects.toThrow();
  });
});
