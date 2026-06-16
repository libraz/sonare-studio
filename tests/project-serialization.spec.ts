import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addMidiClip,
  addNote,
  addTrack,
  canUndo,
  clearHistory,
  removeTrack,
  renameClip,
  setActiveClip,
  setAutomationLaneEnabled,
  setAutomationLanePoints,
  setClipCcLane,
  setClipGain,
  setClipLoop,
  setMarker,
  setProjectChords,
  setSections,
  setTempoSegments,
  setTimeSignatures,
  setTrackColor,
  setTrackInstrument,
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

  it('round-trips clip CC lanes through the document', async () => {
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1, velocity: 100 });
    setClipCcLane(store.clipId, 1, 0, [
      { ppq: 0, value: 0 },
      { ppq: 2, value: 127 },
    ]);
    const doc = serializeProject();
    expect(doc.tracks[0].clips[0].ccLanes).toEqual([
      {
        controller: 1,
        channel: 0,
        points: [
          { ppq: 0, value: 0 },
          { ppq: 2, value: 127 },
        ],
      },
    ]);

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(serializeProject()).toEqual(doc);
    expect(store.activeClip?.ccLanes).toEqual(doc.tracks[0].clips[0].ccLanes);
  });

  it('round-trips imported clip pitch-bend lanes through the document', async () => {
    const doc = serializeProject();
    doc.tracks[0].clips[0].pitchBendLanes = [
      {
        channel: 0,
        points: [
          { ppq: 0, value: 8192 },
          { ppq: 1, value: 4096 },
        ],
      },
    ];

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);

    expect(serializeProject()).toEqual(doc);
    expect(store.activeClip?.pitchBendLanes).toEqual(doc.tracks[0].clips[0].pitchBendLanes);
  });

  it('round-trips imported aftertouch lanes through the document', async () => {
    const doc = serializeProject();
    doc.tracks[0].clips[0].channelPressureLanes = [
      {
        channel: 0,
        points: [
          { ppq: 0, value: 20 },
          { ppq: 1, value: 80 },
        ],
      },
    ];
    doc.tracks[0].clips[0].polyPressureLanes = [
      {
        channel: 0,
        pitch: 60,
        points: [{ ppq: 0.5, value: 64 }],
      },
    ];

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);

    expect(serializeProject()).toEqual(doc);
    expect(store.activeClip?.channelPressureLanes).toEqual(
      doc.tracks[0].clips[0].channelPressureLanes,
    );
    expect(store.activeClip?.polyPressureLanes).toEqual(doc.tracks[0].clips[0].polyPressureLanes);
  });

  it('round-trips the chord track through the document', async () => {
    setProjectChords([
      { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0, bassPc: 4 },
      { startPpq: 4, endPpq: 8, rootPc: 7, quality: 4 },
    ]);
    const doc = serializeProject();
    expect(doc.chords).toEqual([
      { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0, bassPc: 4 },
      { startPpq: 4, endPpq: 8, rootPc: 7, quality: 4 },
    ]);

    // The chord stream is replayed through annotateChords and read back from
    // the rebuilt Project, so re-serializing yields the same document.
    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(serializeProject()).toEqual(doc);
    expect(store.chords).toEqual(doc.chords);
  });

  it('omits the chord track from the document when empty', () => {
    const doc = serializeProject();
    expect(doc.chords).toBeUndefined();
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

  it('serializes automation onto track entries and re-targets lanes across fresh ids', async () => {
    buildSampleProject(store);
    // Automation-less sessions omit the fields entirely.
    const emptyDoc = serializeProject();
    expect(emptyDoc.masterAutomation).toBeUndefined();
    expect(emptyDoc.tracks.every((track) => track.automation === undefined)).toBe(true);

    // Removing the first track leaves the Bass track with a non-contiguous id;
    // loading must still resolve its lanes (fresh ids are assigned on load).
    removeTrack(store.tracks[0].id);
    const bassTrackId = store.tracks.find((track) => track.name === 'Bass')?.id as number;
    setAutomationLanePoints(bassTrackId, 'faderDb', [
      { ppq: 0, value: -6 },
      { ppq: 8, value: 0, curve: 'hold' },
    ]);
    setAutomationLanePoints('master', 'pan', [{ ppq: 4, value: 0.5 }]);
    setAutomationLaneEnabled('master', 'pan', false);

    const doc = serializeProject();
    expect(doc.tracks.map((track) => track.name)).toEqual(['Bass']);
    expect(doc.tracks[0].automation).toEqual([
      {
        param: 'faderDb',
        points: [
          { ppq: 0, value: -6 },
          { ppq: 8, value: 0, curve: 'hold' },
        ],
        enabled: true,
      },
    ]);
    expect(doc.masterAutomation).toEqual([
      { param: 'pan', points: [{ ppq: 4, value: 0.5 }], enabled: false },
    ]);

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    const loadedBass = store.tracks.find((track) => track.name === 'Bass');
    expect(loadedBass).toBeDefined();
    expect(store.automationLanes).toEqual([
      {
        target: loadedBass?.id,
        param: 'faderDb',
        points: [
          { ppq: 0, value: -6 },
          { ppq: 8, value: 0, curve: 'hold' },
        ],
        enabled: true,
      },
      { target: 'master', param: 'pan', points: [{ ppq: 4, value: 0.5 }], enabled: false },
    ]);
    expect(serializeProject()).toEqual(doc);
  });

  it('loading defaults absent automation to [] and drops malformed entries', async () => {
    buildSampleProject(store);
    const doc = serializeProject();
    await loadProjectDocument(doc);
    expect(store.automationLanes).toEqual([]);

    const withBadLanes = {
      ...doc,
      tracks: [
        {
          ...doc.tracks[0],
          automation: [
            { param: 'volume', points: [], enabled: true },
            { param: 'pan', points: 'oops', enabled: true },
            {
              param: 'faderDb',
              points: [
                { ppq: 8, value: 999 },
                { ppq: -1, value: 0 },
                { ppq: 0, value: -3 },
              ],
            },
          ],
        },
        ...doc.tracks.slice(1),
      ],
      masterAutomation: 'oops',
    } as unknown as ProjectDocument;
    await loadProjectDocument(withBadLanes);
    expect(store.automationLanes).toEqual([
      {
        target: store.tracks[0].id,
        param: 'faderDb',
        points: [
          { ppq: 0, value: -3 },
          { ppq: 8, value: 24 },
        ],
        enabled: true,
      },
    ]);
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

  it('exportProjectSmf returns SMF bytes with a sanitized .mid filename', async () => {
    store.projectName = 'A/B: take *2*';
    const result = await exportProjectSmf();
    expect(result.filename).toBe('A_B_ take _2_.mid');
    expect(Array.from(result.bytes.subarray(0, 4))).toEqual([0x4d, 0x54, 0x68, 0x64]);
  });

  it('exportProjectClipFile returns SMF2CLIP bytes with a .midi2 filename', () => {
    const result = exportProjectClipFile('demo');
    expect(result.filename).toBe('demo.midi2');
    expect(result.bytes.length).toBeGreaterThan(0);
  });

  it('exportClipSmf preserves one clip with app-level MIDI metadata', async () => {
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    setClipCcLane(store.clipId, 1, 0, [{ ppq: 0.25, value: 64 }]);
    setTrackInstrument(store.activeTrackId, { kind: 'synth-preset', preset: 'sub-bass' });
    store.clips = store.clips.map((clip) =>
      clip.id === store.clipId
        ? {
            ...clip,
            pitchBendLanes: [{ channel: 0, points: [{ ppq: 0.5, value: 4096 }] }],
            channelPressureLanes: [{ channel: 0, points: [{ ppq: 0.75, value: 70 }] }],
            polyPressureLanes: [{ channel: 0, pitch: 60, points: [{ ppq: 0.9, value: 80 }] }],
          }
        : clip,
    );
    renameClip(store.clipId, 'Lead line');
    const result = await exportClipSmf(store.clipId);
    expect(result.filename).toBe('Lead line.mid');
    expect(Array.from(result.bytes.subarray(0, 4))).toEqual([0x4d, 0x54, 0x68, 0x64]);
    await expect(exportClipSmf(9999)).rejects.toThrow(RangeError);
  });
});
