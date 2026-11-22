import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAudioAssetCache,
  computeAssetId,
  interleaveChannels,
  listAssets,
} from '@/persistence/assets';
import { clearHistory, importExternalStems, redo, undo } from '@/project/commands';
import {
  EXTERNAL_STEM_ROLES,
  externalStemTrackName,
  inferExternalStemRole,
} from '@/project/external-stems';
import {
  loadProjectDocument,
  type ProjectDocument,
  serializeProject,
} from '@/project/serialization';
import { getProject, useProjectStore } from '@/project/store';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** Shape of the fake Project document this spec reads back. */
interface FakeDoc {
  tracks: Array<{ id: number; kind: number; name: string }>;
  clips: Array<{ id: number; trackId: number; sourceId: number; lengthPpq: number }>;
}

function readDoc(): FakeDoc {
  return JSON.parse(getProject().toJson()) as FakeDoc;
}

/** Reads the metadata strings the Project stores for a clip's audio source. */
function sourceMetadata(clipId: number): { contentHash?: string; externalStemRole?: string } {
  const sourceId = readDoc().clips.find((clip) => clip.id === clipId)?.sourceId ?? 0;
  const source = getProject()
    .sources()
    .find((entry) => entry.id === sourceId);
  return {
    ...(source?.contentHash !== undefined ? { contentHash: source.contentHash } : {}),
    ...(source?.externalStemRole !== undefined
      ? { externalStemRole: source.externalStemRole }
      : {}),
  };
}

/** One decoded mono stem, four frames at 4 Hz (= 1 s = 2 PPQ at 120 BPM). */
function stem(name: string, role: (typeof EXTERNAL_STEM_ROLES)[number], seed: number) {
  return {
    channels: [new Float32Array([seed, seed + 1, seed + 2, seed + 3])],
    sampleRate: 4,
    name,
    role,
  };
}

function expectedAssetId(input: ReturnType<typeof stem>): string {
  return computeAssetId(interleaveChannels(input.channels), input.sampleRate, 1);
}

describe('inferExternalStemRole', () => {
  it('matches the role words and their unambiguous synonyms, case-insensitively', () => {
    expect(inferExternalStemRole('song - vocals.wav')).toBe('vocals');
    expect(inferExternalStemRole('SONG_Vocal_take.flac')).toBe('vocals');
    expect(inferExternalStemRole('lead vox.wav')).toBe('vocals');
    expect(inferExternalStemRole('Drums.wav')).toBe('drums');
    expect(inferExternalStemRole('song_drum_bus.wav')).toBe('drums');
    expect(inferExternalStemRole('BASS.WAV')).toBe('bass');
  });

  it('falls back to "other" for names without a role marker', () => {
    expect(inferExternalStemRole('stem_4.wav')).toBe('other');
    expect(inferExternalStemRole('')).toBe('other');
    expect(inferExternalStemRole('piano.wav')).toBe('other');
    expect(inferExternalStemRole('other.wav')).toBe('other');
  });

  it('resolves multi-marker names by role order, not word order', () => {
    expect(inferExternalStemRole('bass_and_drums.wav')).toBe('drums');
    expect(inferExternalStemRole('drums_and_vocals.wav')).toBe('vocals');
  });

  it('names tracks after the role', () => {
    expect(EXTERNAL_STEM_ROLES.map(externalStemTrackName)).toEqual([
      'Vocals',
      'Drums',
      'Bass',
      'Other',
    ]);
  });
});

describe('importExternalStems', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    clearAudioAssetCache();
    installMockOpfs();
    await store.init();
  });

  afterEach(() => {
    uninstallMockOpfs();
    clearAudioAssetCache();
  });

  it('lays down one track and clip per stem, aligned at the insertion point', async () => {
    const stems = [stem('Song vocals', 'vocals', 0), stem('Song drums', 'drums', 10)];
    const clipIds = await importExternalStems(stems, { startPpq: 8 });

    expect(clipIds).toHaveLength(2);
    const clips = clipIds.map((id) => store.clips.find((clip) => clip.id === id));
    expect(clips.map((clip) => clip?.name)).toEqual(['Song vocals', 'Song drums']);
    expect(clips.map((clip) => clip?.startPpq)).toEqual([8, 8]);
    // Four frames at 4 Hz is one second, i.e. two quarter notes at 120 BPM.
    expect(clips.map((clip) => clip?.lengthPpq)).toEqual([2, 2]);
    expect(clips.map((clip) => clip?.externalStemRole)).toEqual(['vocals', 'drums']);
    const trackNames = clips.map(
      (clip) => store.tracks.find((track) => track.id === clip?.trackId)?.name,
    );
    expect(trackNames).toEqual(['Vocals', 'Drums']);
    // Each stem is stored as its own asset, addressed by its content.
    expect(clips.map((clip) => clip?.assetId)).toEqual(stems.map(expectedAssetId));
    expect((await listAssets()).map((asset) => asset.id).sort()).toEqual(
      stems.map(expectedAssetId).sort(),
    );
  });

  it('records the asset id and role as the audio source metadata', async () => {
    const stems = [stem('Song bass', 'bass', 0), stem('Song other', 'other', 20)];
    const clipIds = await importExternalStems(stems, { startPpq: 0 });

    expect(sourceMetadata(clipIds[0])).toEqual({
      contentHash: expectedAssetId(stems[0]),
      externalStemRole: 'bass',
    });
    expect(sourceMetadata(clipIds[1])).toEqual({
      contentHash: expectedAssetId(stems[1]),
      externalStemRole: 'other',
    });
  });

  it('undoes the whole import in one step, native project included', async () => {
    const baselineTracks = readDoc().tracks.length;
    const baselineClips = readDoc().clips.length;
    const baselineSources = getProject().sources().length;
    const mirrorTracks = store.tracks.length;
    const mirrorClips = store.clips.length;
    clearHistory();

    const clipIds = await importExternalStems(
      [stem('Song vocals', 'vocals', 0), stem('Song drums', 'drums', 10)],
      { startPpq: 4 },
    );
    expect(clipIds).toHaveLength(2);
    expect(readDoc().tracks).toHaveLength(baselineTracks + 2);
    expect(readDoc().clips).toHaveLength(baselineClips + 2);

    expect(undo()).toBe(true);
    // Every native entry the command reported is replayed: the project is back
    // to its pre-import track, clip and source counts.
    expect(readDoc().tracks).toHaveLength(baselineTracks);
    expect(readDoc().clips).toHaveLength(baselineClips);
    expect(getProject().sources().length).toBe(baselineSources);
    expect(store.tracks).toHaveLength(mirrorTracks);
    expect(store.clips).toHaveLength(mirrorClips);
    expect(undo()).toBe(false);

    expect(redo()).toBe(true);
    expect(readDoc().tracks).toHaveLength(baselineTracks + 2);
    expect(readDoc().clips).toHaveLength(baselineClips + 2);
    expect(store.clips.filter((clip) => clip.externalStemRole !== undefined)).toHaveLength(2);
    expect(sourceMetadata(store.clips.filter((clip) => clip.kind === 'audio')[0].id)).toMatchObject(
      { externalStemRole: 'vocals' },
    );
  });

  it('rejects a stem without audio and stores nothing', async () => {
    await expect(
      importExternalStems([{ channels: [], sampleRate: 4, name: 'Empty', role: 'other' }], {
        startPpq: 0,
      }),
    ).rejects.toThrow(/has no audio/);
    expect(await listAssets()).toEqual([]);
  });
});

describe('external stem provenance persistence', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    clearAudioAssetCache();
    installMockOpfs();
    await store.init();
  });

  afterEach(() => {
    uninstallMockOpfs();
    clearAudioAssetCache();
  });

  it('round-trips the stem role and content hash through a document', async () => {
    const stems = [stem('Song vocals', 'vocals', 0), stem('Song bass', 'bass', 30)];
    await importExternalStems(stems, { startPpq: 4 });

    const doc = serializeProject();
    const stemClips = doc.tracks.flatMap((track) => track.clips).filter((clip) => clip.assetId);
    expect(stemClips).toHaveLength(2);
    expect(stemClips[0]).toMatchObject({
      externalStemRole: 'vocals',
      contentHash: expectedAssetId(stems[0]),
    });
    expect(stemClips[1]).toMatchObject({
      externalStemRole: 'bass',
      contentHash: expectedAssetId(stems[1]),
    });

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(serializeProject()).toEqual(doc);
    const reloaded = store.clips.filter((clip) => clip.kind === 'audio');
    expect(reloaded.map((clip) => clip.externalStemRole)).toEqual(['vocals', 'bass']);
    expect(reloaded.map((clip) => clip.contentHash)).toEqual(stems.map(expectedAssetId));
    // The provenance is replayed onto the rebuilt Project's audio sources.
    expect(sourceMetadata(reloaded[0].id)).toEqual({
      contentHash: expectedAssetId(stems[0]),
      externalStemRole: 'vocals',
    });
    expect(sourceMetadata(reloaded[1].id)).toEqual({
      contentHash: expectedAssetId(stems[1]),
      externalStemRole: 'bass',
    });
  });

  it('loads documents written before the provenance fields existed', async () => {
    await importExternalStems([stem('Song vocals', 'vocals', 0)], { startPpq: 0 });
    const doc = JSON.parse(JSON.stringify(serializeProject())) as ProjectDocument;
    for (const track of doc.tracks) {
      track.clips = track.clips.map(
        ({ externalStemRole: _role, contentHash: _hash, ...rest }) => rest,
      );
    }

    await loadProjectDocument(doc);

    const audioClips = store.clips.filter((clip) => clip.kind === 'audio');
    expect(audioClips).toHaveLength(1);
    expect(audioClips[0].externalStemRole).toBeUndefined();
    expect(audioClips[0].contentHash).toBeUndefined();
    expect(sourceMetadata(audioClips[0].id)).toEqual({});
    expect(serializeProject()).toEqual(doc);
  });

  it('drops an unknown role from a document rather than trusting it', async () => {
    await importExternalStems([stem('Song vocals', 'vocals', 0)], { startPpq: 0 });
    const doc = JSON.parse(JSON.stringify(serializeProject())) as ProjectDocument;
    for (const track of doc.tracks) {
      for (const clip of track.clips) {
        if (clip.externalStemRole !== undefined) {
          (clip as { externalStemRole?: string }).externalStemRole = 'guitar';
        }
      }
    }

    await loadProjectDocument(doc);

    const audioClips = store.clips.filter((clip) => clip.kind === 'audio');
    expect(audioClips[0].externalStemRole).toBeUndefined();
    expect(sourceMetadata(audioClips[0].id).externalStemRole).toBeUndefined();
  });
});
