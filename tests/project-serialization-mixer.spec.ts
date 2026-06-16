import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addInsert,
  addMixerBus,
  addVcaGroup,
  clearHistory,
  setSend,
  setStripEq,
  setStripGain,
  setStripOutputBus,
  setStripPan,
  setTrackInstrument,
  setTrackSoloSafe,
  setTrackVca,
} from '@/project/commands';
import {
  loadProjectDocument,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  type ProjectDocument,
  serializeProject,
} from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { createTemplate, TEMPLATE_NAMES } from '@/project/templates';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('project serialization with instruments and mixer (schema v3)', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('writes schema version 3', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBe(3);
    expect(serializeProject().schemaVersion).toBe(3);
  });

  it('omits instrument/mixer fields while everything is default', () => {
    const doc = serializeProject();
    expect(doc.mixer).toBeUndefined();
    for (const track of doc.tracks) {
      expect(track.instrument).toBeUndefined();
      expect(track.mixer).toBeUndefined();
    }
  });

  it('serializes instrument, strips and the project mixer state', () => {
    const trackId = store.tracks[0].id;
    setTrackInstrument(trackId, { kind: 'sf2', fontId: 'gm-font', bank: 128, program: 25 });
    setStripGain(trackId, -4.5);
    setStripPan(trackId, 0.3);
    addInsert(trackId, 'dynamics.compressor', { thresholdDb: -18, ratio: 4 });
    setStripEq(trackId, { enabled: true, bands: [{ type: 'Peak', frequencyHz: 900, gainDb: 2 }] });
    const busId = addMixerBus({ name: 'FX' });
    setSend(trackId, busId, { levelDb: -12 });
    setStripGain('master', -1.5);

    const doc = serializeProject();
    expect(doc.tracks[0].instrument).toEqual({
      kind: 'sf2',
      fontId: 'gm-font',
      bank: 128,
      program: 25,
    });
    expect(doc.tracks[0].mixer).toEqual({
      gainDb: -4.5,
      pan: 0.3,
      inserts: [
        {
          processor: 'dynamics.compressor',
          params: { thresholdDb: -18, ratio: 4 },
          enabled: true,
        },
      ],
      sends: [{ busId, levelDb: -12, enabled: true }],
      eq: { enabled: true, bands: [{ type: 'Peak', frequencyHz: 900, gainDb: 2 }] },
    });
    expect(doc.mixer?.master.gainDb).toBe(-1.5);
    expect(doc.mixer?.buses).toEqual([{ id: busId, name: 'FX', gainDb: 0 }]);

    // JSON round-trip stays lossless (plain data only).
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });

  it('round-trips: load + re-serialize yields the same document', async () => {
    const trackId = store.tracks[0].id;
    setTrackInstrument(trackId, { kind: 'synth-patch', patch: { preset: 'saw-lead', drive: 0.4 } });
    setStripGain(trackId, -3);
    addInsert('master', 'maximizer.maximizer');
    const doc = serializeProject();

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(serializeProject()).toEqual(doc);
    expect(store.tracks[0].instrument).toEqual({
      kind: 'synth-patch',
      patch: { preset: 'saw-lead', drive: 0.4 },
    });
    expect(store.tracks[0].mixer?.gainDb).toBe(-3);
    expect(store.mixer.master.inserts).toHaveLength(1);
  });

  it('round-trips a track output-bus routing through the document', async () => {
    const trackId = store.tracks[0].id;
    const busId = addMixerBus({ name: 'FX' });
    setStripOutputBus(trackId, busId);
    const doc = serializeProject();

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(serializeProject()).toEqual(doc);
    expect(store.tracks[0].mixer?.outputBusId).toBe(busId);
  });

  it('round-trips VCA groups and the per-track solo-safe / VCA assignment', async () => {
    const trackId = store.tracks[0].id;
    const groupId = addVcaGroup({ name: 'Drums' });
    setTrackVca(trackId, groupId);
    setTrackSoloSafe(trackId, true);
    const doc = serializeProject();

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(serializeProject()).toEqual(doc);
    expect(store.mixer.vcaGroups).toEqual([{ id: groupId, name: 'Drums', gainDb: 0 }]);
    expect(store.tracks[0].vcaId).toBe(groupId);
    expect(store.tracks[0].soloSafe).toBe(true);
  });

  it('drops a track VCA assignment whose group is missing from the document', async () => {
    const trackId = store.tracks[0].id;
    const groupId = addVcaGroup();
    setTrackVca(trackId, groupId);
    const doc = serializeProject();
    // Simulate a document whose VCA group was stripped but the assignment kept.
    const tampered = JSON.parse(JSON.stringify(doc)) as ProjectDocument;
    if (tampered.mixer) tampered.mixer.vcaGroups = [];

    await loadProjectDocument(tampered);
    expect(store.tracks[0].vcaId).toBeUndefined();
  });

  it('loads v2 documents seamlessly with defaults injected', async () => {
    const doc = serializeProject();
    const v2 = JSON.parse(JSON.stringify(doc)) as ProjectDocument;
    v2.schemaVersion = 2;
    // A faithful v2 file has no instrument/mixer fields anywhere.
    delete v2.mixer;
    for (const track of v2.tracks) {
      delete track.instrument;
      delete track.mixer;
    }

    await loadProjectDocument(v2);
    expect(store.tracks[0].instrument).toBeUndefined();
    expect(store.tracks[0].mixer).toBeUndefined();
    expect(store.mixer).toEqual({
      master: { gainDb: 0, pan: 0, inserts: [], sends: [] },
      buses: [],
    });
    // Re-serializing upgrades to the current schema.
    expect(serializeProject().schemaVersion).toBe(3);
  });

  it('loading a mixer-less document resets a previously loaded mixer', async () => {
    setStripGain('master', -9);
    addMixerBus();
    await loadProjectDocument(createTemplate('empty'));
    expect(store.mixer.master.gainDb).toBe(0);
    expect(store.mixer.buses).toEqual([]);
  });
});

describe('template instrument assignment', () => {
  it('band assigns sensible synth presets per role', () => {
    const byName = new Map(createTemplate('band').tracks.map((t) => [t.name, t.instrument]));
    expect(byName.get('Drums')).toEqual({ kind: 'synth-preset', preset: 'drum-kit' });
    expect(byName.get('Bass')).toEqual({ kind: 'synth-preset', preset: 'sub-bass' });
    expect(byName.get('Piano')).toEqual({ kind: 'synth-preset', preset: 'e-piano' });
    expect(byName.get('Guitar')).toEqual({ kind: 'synth-preset', preset: 'electric-guitar' });
  });

  it('gm-orchestra routes percussion to a percussion-capable preset', () => {
    const tracks = createTemplate('gm-orchestra').tracks;
    const percussion = tracks.filter((t) => t.name === 'Timpani' || t.name === 'Percussion');
    expect(percussion).toHaveLength(2);
    for (const track of percussion) {
      expect(track.instrument).toEqual({ kind: 'synth-preset', preset: 'drum-kit' });
    }
    // Every orchestral track carries some instrument.
    for (const track of tracks) {
      expect(track.instrument?.kind).toBe('synth-preset');
    }
  });

  it('programming assigns synth-oriented presets', () => {
    const byName = new Map(createTemplate('programming').tracks.map((t) => [t.name, t.instrument]));
    expect(byName.get('Lead Synth')).toEqual({ kind: 'synth-preset', preset: 'saw-lead' });
    expect(byName.get('Synth Bass')).toEqual({ kind: 'synth-preset', preset: 'sub-bass' });
  });

  it('transcription and empty keep the default instrument', () => {
    for (const track of createTemplate('transcription').tracks) {
      expect(track.instrument).toBeUndefined();
    }
    expect(createTemplate('empty').tracks).toEqual([]);
  });

  it('all template documents stay JSON-able with the current schema', () => {
    for (const name of TEMPLATE_NAMES) {
      const doc = createTemplate(name);
      expect(doc.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
      expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
    }
  });
});
