import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addMidiClip,
  addNote,
  addTrack,
  canUndo,
  clearHistory,
  renameClip,
  setActiveClip,
  setClipGain,
  setClipLoop,
  setMarker,
  setSections,
  setTempoSegments,
  setTimeSignatures,
  setTrackColor,
  setTrackMute,
  setTrackPan,
  setTrackSolo,
  setTrackVolume,
} from '@/project/commands';
import { exportClipSmf, exportProjectClipFile, exportProjectSmf } from '@/project/export';
import {
  loadProjectDocument,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  type ProjectDocument,
  serializeProject,
} from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { createTemplate } from '@/project/templates';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** Builds a representative multi-track project through the command layer. */
function buildSampleProject(store: ReturnType<typeof useProjectStore>): void {
  store.projectName = 'My Song';
  setTempoSegments([
    { startPpq: 0, bpm: 100 },
    { startPpq: 16, bpm: 132, endBpm: 140 },
  ]);
  setTimeSignatures([{ startPpq: 0, numerator: 3, denominator: 4 }]);

  const pianoTrackId = store.tracks[0].id;
  setTrackColor(pianoTrackId, '#ff8800');
  renameClip(store.clipId, 'Piano riff');
  addNote({ pitch: 60, startPpq: 0, durationPpq: 1, velocity: 100 });
  addNote({ pitch: 64, startPpq: 1.5, durationPpq: 0.5, velocity: 80, channel: 2 });
  setClipGain(store.clipId, 0.75);

  const bassTrackId = addTrack({ name: 'Bass', color: '#22cc88' });
  setTrackMute(bassTrackId, true);
  setTrackSolo(bassTrackId, true);
  setTrackVolume(bassTrackId, 0.5);
  setTrackPan(bassTrackId, -0.4);
  const bassClipId = addMidiClip({ trackId: bassTrackId, startPpq: 8, lengthPpq: 16, name: 'Low' });
  setClipLoop(bassClipId, true, 4);
  setActiveClip(bassClipId);
  addNote({ pitch: 36, startPpq: 0, durationPpq: 2, velocity: 110, offVelocity: 20 });

  setMarker(null, 0, 'Intro');
  setMarker(null, 16, 'Drop');
  setSections([
    { name: 'Verse', startPpq: 0, endPpq: 16, color: '#334455' },
    { name: 'Chorus', startPpq: 16, endPpq: 32 },
  ]);
}

describe('project serialization', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('serializeProject emits a plain JSON-able document with the current schema', () => {
    buildSampleProject(store);
    const doc = serializeProject();
    expect(doc.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(doc.name).toBe('My Song');
    expect(doc.sampleRate).toBe(48000);
    // JSON round-trip must be lossless: no Sets, Maps, class instances or ids.
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });

  it('captures tracks, clips, notes, markers, sections, tempo and meter', () => {
    buildSampleProject(store);
    const doc = serializeProject();

    expect(doc.tempoSegments).toEqual([
      { startPpq: 0, bpm: 100 },
      { startPpq: 16, bpm: 132, endBpm: 140 },
    ]);
    expect(doc.timeSignatures).toEqual([{ startPpq: 0, numerator: 3, denominator: 4 }]);

    expect(doc.tracks.map((t) => t.name)).toEqual(['Piano', 'Bass']);
    expect(doc.tracks[0]).toMatchObject({ color: '#ff8800', mute: false, solo: false });
    expect(doc.tracks[1]).toMatchObject({
      color: '#22cc88',
      mute: true,
      solo: true,
      volume: 0.5,
      pan: -0.4,
    });

    const pianoClip = doc.tracks[0].clips[0];
    expect(pianoClip).toMatchObject({ name: 'Piano riff', startPpq: 0, lengthPpq: 32, gain: 0.75 });
    expect(pianoClip.notes).toEqual([
      { pitch: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0 },
      { pitch: 64, velocity: 80, startPpq: 1.5, durationPpq: 0.5, channel: 2 },
    ]);

    const bassClip = doc.tracks[1].clips[0];
    expect(bassClip).toMatchObject({
      name: 'Low',
      startPpq: 8,
      lengthPpq: 16,
      loopEnabled: true,
      loopLengthPpq: 4,
    });
    expect(bassClip.notes).toEqual([
      { pitch: 36, velocity: 110, startPpq: 0, durationPpq: 2, channel: 0, offVelocity: 20 },
    ]);

    expect(doc.markers).toEqual([
      { ppq: 0, name: 'Intro' },
      { ppq: 16, name: 'Drop' },
    ]);
    expect(doc.sections).toEqual([
      { name: 'Verse', color: '#334455', startPpq: 0, endPpq: 16 },
      { name: 'Chorus', color: expect.any(String), startPpq: 16, endPpq: 32 },
    ]);
  });

  it('loadProjectDocument round-trips: re-serializing yields the same document', async () => {
    buildSampleProject(store);
    const doc = serializeProject();

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(serializeProject()).toEqual(doc);

    // The loaded document is the new baseline, not an undoable edit.
    expect(canUndo()).toBe(false);
    expect(store.initialized).toBe(true);
    expect(store.activeTrackId).toBe(store.tracks[0].id);
  });

  it('loading replaces the current project content entirely', async () => {
    buildSampleProject(store);
    await loadProjectDocument(createTemplate('band'));
    expect(store.projectName).toBe('Band');
    expect(store.tracks.map((t) => t.name)).toEqual(['Drums', 'Bass', 'Piano', 'Guitar', 'Vocal']);
    expect(store.clips).toHaveLength(5);
    expect(store.markers).toEqual([]);
    expect(store.sections).toEqual([]);
    expect(store.notes).toEqual([]);
  });

  it('rejects unsupported schema versions and keeps the open project alive', async () => {
    buildSampleProject(store);
    const doc = serializeProject();
    const bad = { ...doc, schemaVersion: 0 };
    await expect(loadProjectDocument(bad)).rejects.toThrow(/schema version/);
    // The previous project is untouched.
    expect(serializeProject()).toEqual(doc);
  });
});

describe('MIDI export commands', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('exportProjectSmf returns SMF bytes with a sanitized .mid filename', () => {
    store.projectName = 'A/B: take *2*';
    const result = exportProjectSmf();
    expect(result.filename).toBe('A_B_ take _2_.mid');
    expect(Array.from(result.bytes.subarray(0, 4))).toEqual([0x4d, 0x54, 0x68, 0x64]);
  });

  it('exportProjectClipFile returns SMF2CLIP bytes with a .midi2 filename', () => {
    const result = exportProjectClipFile('demo');
    expect(result.filename).toBe('demo.midi2');
    expect(result.bytes.length).toBeGreaterThan(0);
  });

  it('exportClipSmf renders one clip into a scratch project', async () => {
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    renameClip(store.clipId, 'Lead line');
    const result = await exportClipSmf(store.clipId);
    expect(result.filename).toBe('Lead line.mid');
    expect(Array.from(result.bytes.subarray(0, 4))).toEqual([0x4d, 0x54, 0x68, 0x64]);
    await expect(exportClipSmf(9999)).rejects.toThrow(RangeError);
  });
});
