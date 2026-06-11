import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addAudioClip,
  addAudioTrack,
  addNote,
  canUndo,
  clearHistory,
  setClipFades,
} from '@/project/commands';
import {
  loadProjectDocument,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  type ProjectDocument,
  serializeProject,
} from '@/project/serialization';
import { getProject, useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** Builds a project with one MIDI clip (with a note) and two audio clips. */
async function buildMixedProject(store: ReturnType<typeof useProjectStore>): Promise<void> {
  store.projectName = 'Mixed';
  addNote({ pitch: 60, startPpq: 0, durationPpq: 1, velocity: 100 });
  const audioTrackId = addAudioTrack({ name: 'Vox' });
  const firstAudio = await addAudioClip({
    trackId: audioTrackId,
    assetId: 'asset-vox',
    startPpq: 4,
    lengthPpq: 8,
    gain: 0.9,
    name: 'Verse vox',
  });
  setClipFades(firstAudio, 0.5, 1);
  await addAudioClip({
    trackId: audioTrackId,
    assetId: 'asset-vox',
    startPpq: 16,
    lengthPpq: 4,
    name: 'Chorus vox',
  });
}

describe('project serialization with audio clips (schema v2)', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('writes the current schema version (>= 2, audio clips supported)', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
    expect(serializeProject().schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
  });

  it('serializes audio clips with kind, assetId and fades (no PCM payload)', async () => {
    await buildMixedProject(store);
    const doc = serializeProject();

    const midiClip = doc.tracks[0].clips[0];
    expect(midiClip.kind).toBe('midi');
    expect(midiClip.assetId).toBeUndefined();

    const audioTrack = doc.tracks[1];
    expect(audioTrack.kind).toBe('audio');
    expect(audioTrack.clips[0]).toMatchObject({
      name: 'Verse vox',
      kind: 'audio',
      assetId: 'asset-vox',
      startPpq: 4,
      lengthPpq: 8,
      gain: 0.9,
      fadeInPpq: 0.5,
      fadeOutPpq: 1,
      notes: [],
    });
    expect(audioTrack.clips[1]).toMatchObject({
      name: 'Chorus vox',
      kind: 'audio',
      assetId: 'asset-vox',
    });
    expect(audioTrack.clips[1].fadeInPpq).toBeUndefined();

    // Documents stay plain JSON (assets live in OPFS, never inline).
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });

  it('round-trips: load + re-serialize yields the same document', async () => {
    await buildMixedProject(store);
    const doc = serializeProject();

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(serializeProject()).toEqual(doc);
    expect(canUndo()).toBe(false);

    // The reloaded mirror carries the audio metadata.
    const audioClips = store.clips.filter((c) => c.kind === 'audio');
    expect(audioClips).toHaveLength(2);
    expect(audioClips[0]).toMatchObject({ assetId: 'asset-vox', fadeInPpq: 0.5, fadeOutPpq: 1 });
  });

  it('registers one Project source per asset when loading', async () => {
    await buildMixedProject(store);
    const doc = serializeProject();
    await loadProjectDocument(doc);

    const fakeDoc = JSON.parse(getProject().toJson()) as {
      clips: Array<{ id: number; source_id: number }>;
    };
    const audioClips = store.clips.filter((c) => c.kind === 'audio');
    const sourceIds = audioClips.map(
      (clip) => fakeDoc.clips.find((c) => c.id === clip.id)?.source_id,
    );
    expect(sourceIds[0]).toBeDefined();
    expect(sourceIds[1]).toBe(sourceIds[0]);
  });

  it('loads version-1 documents (no clip kind) as MIDI seamlessly', async () => {
    addNote({ pitch: 64, startPpq: 0, durationPpq: 1 });
    const doc = serializeProject();
    // Rebuild the document as a faithful v1 file: no kind/asset/fade fields.
    const v1 = JSON.parse(JSON.stringify(doc)) as ProjectDocument;
    v1.schemaVersion = 1;
    for (const track of v1.tracks) {
      track.clips = track.clips.map(
        ({ kind: _kind, assetId: _assetId, fadeInPpq: _in, fadeOutPpq: _out, ...rest }) => rest,
      );
    }

    await loadProjectDocument(v1);
    expect(store.clips).toHaveLength(1);
    expect(store.clips[0].kind).toBeUndefined(); // effective kind: 'midi'
    expect(store.clips[0].notes.map((n) => n.pitch)).toEqual([64]);
    // Re-serializing upgrades to the current schema with explicit midi kinds.
    const upgraded = serializeProject();
    expect(upgraded.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(upgraded.tracks[0].clips[0].kind).toBe('midi');
  });

  it('keeps audio clips when their asset is absent from the asset store', async () => {
    // Loading never touches the asset store: a document referencing missing
    // assets still loads, the clips just stay silent until restored.
    await buildMixedProject(store);
    const doc = serializeProject();
    await loadProjectDocument(doc); // no OPFS mock installed at all
    expect(store.clips.filter((c) => c.kind === 'audio')).toHaveLength(2);
  });
});
