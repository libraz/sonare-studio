import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addAudioClip,
  addAudioTrack,
  addGroupTrack,
  addInsert,
  addNote,
  canUndo,
  clearHistory,
  setClipCompSegments,
  setClipFades,
  setClipWarp,
  setInsertSidechain,
  setTrackFrozen,
  setTrackGroup,
  setTrackRecordInputChannel,
} from '@/project/commands';
import { createDefaultMixerState } from '@/project/mixer';
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

  it('serializes audio track record input channels and round-trips them', async () => {
    const trackId = addAudioTrack({ name: 'Mic 3' });
    setTrackRecordInputChannel(trackId, 2);

    const doc = serializeProject();
    expect(doc.tracks[1].recordInputChannel).toBe(2);

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(store.tracks.find((track) => track.name === 'Mic 3')?.recordInputChannel).toBe(2);
    expect(serializeProject()).toEqual(doc);
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

  it('serializes clip warp (with anchors) and round-trips it', async () => {
    const trackId = addAudioTrack({ name: 'Warped' });
    const clipId = await addAudioClip({ trackId, assetId: 'asset-loop', lengthPpq: 8 });
    setClipWarp(clipId, {
      enabled: true,
      sourceBpm: 95,
      anchors: [
        { ppq: 2, sourceSeconds: 1.25 },
        { ppq: 4, sourceSeconds: 2 },
      ],
    });

    const doc = serializeProject();
    const docClip = doc.tracks[1].clips[0];
    expect(docClip.warp).toEqual({
      enabled: true,
      sourceBpm: 95,
      anchors: [
        { ppq: 2, sourceSeconds: 1.25 },
        { ppq: 4, sourceSeconds: 2 },
      ],
    });
    // Documents stay plain JSON (warp is pure metadata, no baked audio).
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    const mirror = store.clips.find((c) => c.kind === 'audio');
    expect(mirror?.warp).toEqual({
      enabled: true,
      sourceBpm: 95,
      anchors: [
        { ppq: 2, sourceSeconds: 1.25 },
        { ppq: 4, sourceSeconds: 2 },
      ],
    });
    const native = JSON.parse(getProject().toJson()) as {
      clips: Array<{ id: number; warp_ref_id?: number; warp_mode?: number }>;
      warp_maps: Array<{ id: number }>;
    };
    expect(native.clips.find((clip) => clip.id === mirror?.id)).toMatchObject({
      warp_ref_id: mirror?.id,
      warp_mode: 2,
    });
    expect(native.warp_maps.some((map) => map.id === mirror?.id)).toBe(true);
    expect(serializeProject()).toEqual(doc);
  });

  it('omits warp from documents and mirrors when a clip has none', async () => {
    const trackId = addAudioTrack();
    await addAudioClip({ trackId, assetId: 'asset-loop', lengthPpq: 8 });
    const doc = serializeProject();
    expect('warp' in doc.tracks[1].clips[0]).toBe(false);
    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(store.clips.find((c) => c.kind === 'audio')?.warp).toBeUndefined();
  });

  it('drops invalid document warp (sourceBpm 0) on load', async () => {
    const trackId = addAudioTrack();
    await addAudioClip({ trackId, assetId: 'asset-loop', lengthPpq: 8 });
    const doc = JSON.parse(JSON.stringify(serializeProject())) as ProjectDocument;
    doc.tracks[1].clips[0].warp = { enabled: true, sourceBpm: 0 };

    await loadProjectDocument(doc);
    expect(store.clips.find((c) => c.kind === 'audio')?.warp).toBeUndefined();
    // The invalid state never resurfaces on re-serialize.
    expect(serializeProject().tracks[1].clips[0].warp).toBeUndefined();
  });

  it('serializes takes and compSegments and round-trips them', async () => {
    const trackId = addAudioTrack({ name: 'Comp' });
    const clipId = await addAudioClip({
      trackId,
      assetId: 'take-b',
      lengthPpq: 8,
      name: 'Comped',
      takes: [
        { assetId: 'take-a', name: 'Take 1' },
        { assetId: 'take-b', name: 'Take 2' },
      ],
    });
    setClipCompSegments(clipId, [
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 4, takeIndex: 1, crossfadePpq: 0 },
      { startPpq: 6, takeIndex: 0, crossfadePpq: 0.25 },
    ]);

    const doc = serializeProject();
    const docClip = doc.tracks[1].clips[0];
    expect(docClip.takes).toEqual([
      { assetId: 'take-a', name: 'Take 1' },
      { assetId: 'take-b', name: 'Take 2' },
    ]);
    expect(docClip.compSegments).toEqual([
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 4, takeIndex: 1, crossfadePpq: 0 },
      { startPpq: 6, takeIndex: 0, crossfadePpq: 0.25 },
    ]);
    // The clip asset follows the take selected at the clip start.
    expect(docClip.assetId).toBe('take-a');
    // Documents stay plain JSON (takes reference assets, never inline PCM).
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    const mirror = store.clips.find((c) => c.kind === 'audio');
    expect(mirror?.takes).toEqual([
      { assetId: 'take-a', name: 'Take 1' },
      { assetId: 'take-b', name: 'Take 2' },
    ]);
    expect(mirror?.compSegments).toEqual([
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 4, takeIndex: 1, crossfadePpq: 0 },
      { startPpq: 6, takeIndex: 0, crossfadePpq: 0.25 },
    ]);
    expect(serializeProject()).toEqual(doc);
  });
});

describe('group membership and insert sidechain serialization (schema v3)', () => {
  let store: ReturnType<typeof useProjectStore>;
  let midiId: number;
  let groupId: number;
  let audioId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    // Track order: 0 = initial MIDI track, 1 = group, 2 = audio member.
    midiId = store.tracks[0].id;
    groupId = addGroupTrack({ name: 'Drum Bus' });
    audioId = addAudioTrack({ name: 'Vox' });
    setTrackGroup(audioId, groupId);
    addInsert(audioId, 'dynamics.compressor', { thresholdDb: -18 });
    setInsertSidechain(audioId, 0, midiId);
  });

  it('serializes groupId and sidechain sources as positional indices', () => {
    const doc = serializeProject();
    expect(doc.tracks[1].kind).toBe('group');
    expect(doc.tracks[1].groupIndex).toBeUndefined();
    expect(doc.tracks[2].groupIndex).toBe(1);
    const slot = doc.tracks[2].mixer?.inserts[0] as unknown as Record<string, unknown>;
    expect(slot.sidechainSourceIndex).toBe(0);
    expect('sidechainSourceTrackId' in slot).toBe(false);

    // Serialization must not leak positional fields into the live mirror.
    const mirrorSlot = store.tracks[2].mixer?.inserts[0] as unknown as Record<string, unknown>;
    expect(mirrorSlot.sidechainSourceTrackId).toBe(midiId);
    expect('sidechainSourceIndex' in mirrorSlot).toBe(false);

    // Documents stay plain JSON.
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });

  it('serializes group-track insert sidechain sources', () => {
    addInsert(groupId, 'dynamics.compressor', { thresholdDb: -12 });
    store.tracks[1].mixer!.inserts[0].sidechainSourceTrackId = midiId;

    const doc = serializeProject();
    const slot = doc.tracks[1].mixer?.inserts[0] as unknown as Record<string, unknown>;
    expect(slot.sidechainSourceIndex).toBe(0);
    expect('sidechainSourceTrackId' in slot).toBe(false);
  });

  it('round-trips memberships and sidechains onto fresh session ids', async () => {
    const doc = serializeProject();
    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(serializeProject()).toEqual(doc);
    expect(canUndo()).toBe(false);

    expect(store.tracks[1].kind).toBe('group');
    expect(store.tracks[2].groupId).toBe(store.tracks[1].id);
    const slot = store.tracks[2].mixer?.inserts[0] as unknown as Record<string, unknown>;
    expect(slot.sidechainSourceTrackId).toBe(store.tracks[0].id);
    // The positional document field must not survive into the loaded mirror.
    expect('sidechainSourceIndex' in slot).toBe(false);
  });

  it('drops dangling session-id references at serialize time', () => {
    store.tracks = store.tracks.map((track) => {
      if (track.id !== audioId) return track;
      return {
        ...track,
        groupId: 987654,
        mixer: {
          ...(track.mixer as NonNullable<typeof track.mixer>),
          inserts: (track.mixer?.inserts ?? []).map((slot) => ({
            ...slot,
            sidechainSourceTrackId: 987654,
          })),
        },
      };
    });
    const doc = serializeProject();
    expect(doc.tracks[2].groupIndex).toBeUndefined();
    const slot = doc.tracks[2].mixer?.inserts[0] as unknown as Record<string, unknown>;
    expect('sidechainSourceIndex' in slot).toBe(false);
    expect('sidechainSourceTrackId' in slot).toBe(false);
  });

  it('drops invalid positional references at load time', async () => {
    const doc = JSON.parse(JSON.stringify(serializeProject())) as ProjectDocument;
    doc.tracks[0].groupIndex = 0; // self reference
    doc.tracks[1].groupIndex = 99; // out of range
    doc.tracks[2].groupIndex = 0; // not a group track
    const slot = doc.tracks[2].mixer?.inserts[0] as unknown as Record<string, unknown>;
    slot.sidechainSourceIndex = 2; // self reference
    doc.tracks[2].mixer?.inserts.push({
      processor: 'saturation.tape',
      params: {},
      enabled: true,
      sidechainSourceIndex: 99, // out of range
    } as never);

    await loadProjectDocument(doc);
    expect(store.tracks.every((track) => track.groupId === undefined)).toBe(true);
    const inserts = store.tracks[2].mixer?.inserts ?? [];
    expect(inserts).toHaveLength(2);
    for (const mirrorSlot of inserts) {
      const record = mirrorSlot as unknown as Record<string, unknown>;
      expect('sidechainSourceTrackId' in record).toBe(false);
      expect('sidechainSourceIndex' in record).toBe(false);
    }
    const reserialized = serializeProject();
    expect(reserialized.tracks.every((track) => track.groupIndex === undefined)).toBe(true);
  });

  it('restores group-track insert sidechain sources at load time', async () => {
    const doc = JSON.parse(JSON.stringify(serializeProject())) as ProjectDocument;
    doc.tracks[1].mixer = {
      gainDb: 0,
      pan: 0,
      sends: [],
      inserts: [
        {
          processor: 'dynamics.compressor',
          params: { thresholdDb: -12 },
          enabled: true,
          sidechainSourceIndex: 0,
        } as never,
      ],
    };

    await loadProjectDocument(doc);

    const slot = store.tracks[1].mixer?.inserts[0] as unknown as Record<string, unknown>;
    expect(slot.processor).toBe('dynamics.compressor');
    expect(slot.sidechainSourceTrackId).toBe(store.tracks[0].id);
    expect('sidechainSourceIndex' in slot).toBe(false);
  });
});

describe('track frozen state serialization', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('round-trips track.frozen through serialize and load', async () => {
    const trackId = addAudioTrack({ name: 'Vox' });
    setTrackFrozen(trackId, { assetId: 'baked-1' });

    const doc = serializeProject();
    expect(doc.tracks[1].frozen).toEqual({ assetId: 'baked-1' });
    // Unfrozen tracks carry no frozen field at all.
    expect('frozen' in doc.tracks[0]).toBe(false);
    // Documents stay plain JSON (the baked PCM lives in the asset store).
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(store.tracks[1].frozen).toEqual({ assetId: 'baked-1' });
    expect(store.tracks[0].frozen).toBeUndefined();
    expect(serializeProject()).toEqual(doc);
    expect(canUndo()).toBe(false);
  });

  it('drops invalid document frozen states on load', async () => {
    addAudioTrack({ name: 'Vox' });
    const doc = JSON.parse(JSON.stringify(serializeProject())) as ProjectDocument;
    doc.tracks[1].frozen = { assetId: '' }; // empty asset id
    doc.tracks[0].frozen = { assetId: 5 } as unknown as { assetId: string }; // not a string

    await loadProjectDocument(doc);
    expect(store.tracks.every((track) => track.frozen === undefined)).toBe(true);
    // The invalid state never resurfaces on re-serialize.
    expect(serializeProject().tracks.every((track) => track.frozen === undefined)).toBe(true);
  });

  it('rejects documents that exceed the realtime engine bus limit', async () => {
    const doc = JSON.parse(JSON.stringify(serializeProject())) as ProjectDocument;
    const mixer = createDefaultMixerState();
    mixer.buses = Array.from({ length: 9 }, (_, index) => ({
      id: `bus-${index}`,
      name: `Bus ${index + 1}`,
      gainDb: 0,
    }));
    doc.mixer = mixer;

    await expect(loadProjectDocument(doc)).rejects.toThrow(/Mixer bus limit exceeded/);
  });
});
