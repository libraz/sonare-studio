import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { linearToDb } from '@/lib/db';
import { decodeSzd, encodeSzd } from '@/persistence/szd';
import { chordTonePitchClasses, type EditorChordSymbol, formatChordName } from '@/project/chords';
import {
  addMasteringProcessor,
  addMidiClip,
  addMixerBus,
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
  setClipChannelPressure,
  setClipGain,
  setClipLoop,
  setClipPitchBend,
  setClipPolyPressure,
  setMarker,
  setProjectChords,
  setProjectExternalMidiDefaultForTracks,
  setSections,
  setTempoSegments,
  setTimeSignatures,
  setTrackColor,
  setTrackInstrument,
  setTrackMidiFx,
  setTrackMute,
  setTrackPan,
  setTrackSolo,
  setTrackVolume,
} from '@/project/commands';
import { exportClipSmf, exportProjectClipFile, exportProjectSmf } from '@/project/export';
import { sanitizeMidiFxConfig } from '@/project/midi-fx';
import {
  loadProjectDocument,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  type ProjectDocument,
  serializeProject,
} from '@/project/serialization';
import { extractSmfSysEx } from '@/project/smf';
import { useProjectStore } from '@/project/store';
import { createTemplate } from '@/project/templates';
import { MAJOR_MODE_MASK } from '@/project/types';
import {
  midiLearnBankActionTargetId,
  midiLearnBankTargetId,
  midiLearnBusStripControlTargetId,
  midiLearnMasteringTargetId,
  midiLearnTransportTargetId,
} from '@/ui/midi/midi-learn';

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

  it('round-trips the project scale and resets it for legacy documents', async () => {
    store.scaleHighlight = { enabled: true, rootPc: 10, modeMask: 0b010110101101 };
    const keyed = serializeProject();
    expect(keyed.scaleHighlight).toEqual(store.scaleHighlight);

    await loadProjectDocument(JSON.parse(JSON.stringify(keyed)) as ProjectDocument);
    expect(store.scaleHighlight).toEqual({ enabled: true, rootPc: 10, modeMask: 0b010110101101 });

    delete keyed.scaleHighlight;
    store.scaleHighlight = { enabled: false, rootPc: 7, modeMask: 0 };
    await loadProjectDocument(keyed);
    expect(store.scaleHighlight).toEqual({ enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK });
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
      volume: 1,
      pan: -0.4,
      mixer: expect.objectContaining({ gainDb: linearToDb(0.5) }),
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

  it('round-trips additive time-signature grouping outside the native meter map', async () => {
    setTimeSignatures([{ startPpq: 0, numerator: 7, denominator: 8, grouping: [2, 2, 3] }]);
    const doc = serializeProject();
    expect(doc.timeSignatures).toEqual([
      { startPpq: 0, numerator: 7, denominator: 8, grouping: [2, 2, 3] },
    ]);

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(store.timeSignatures).toEqual([
      { startPpq: 0, numerator: 7, denominator: 8, grouping: [2, 2, 3] },
    ]);
  });

  it('round-trips an imported pickup measure length', async () => {
    store.pickupLengthPpq = 1;
    const doc = serializeProject();
    expect(doc.pickupLengthPpq).toBe(1);

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(store.pickupLengthPpq).toBe(1);
    expect(serializeProject()).toEqual(doc);
  });

  it('sanitizes malformed track and clip playback numbers during load', async () => {
    buildSampleProject(store);
    const doc = serializeProject();
    const clip = doc.tracks[0].clips[0];
    doc.tracks[0].volume = Number.NaN;
    clip.startPpq = Number.NaN;
    clip.lengthPpq = Number.NEGATIVE_INFINITY;
    clip.sourceOffsetPpq = Number.NaN;
    clip.gain = Number.NEGATIVE_INFINITY;
    clip.loopLengthPpq = Number.NaN;

    await loadProjectDocument(doc);

    expect(store.tracks[0].volume).toBe(1);
    expect(store.clips[0]).toMatchObject({
      startPpq: 0,
      lengthPpq: 1,
      sourceOffsetPpq: 0,
      gain: 1,
    });
  });

  it('migrates legacy track volume into strip gain and re-saves unity volume', async () => {
    const doc = serializeProject();
    doc.tracks[0].volume = 0.5;
    doc.tracks[0].mixer = { gainDb: -3, pan: 0, inserts: [], sends: [] };

    await loadProjectDocument(doc);

    expect(store.tracks[0]).toMatchObject({
      volume: 1,
      mixer: expect.objectContaining({ gainDb: -3 + linearToDb(0.5) }),
    });
    expect(serializeProject().tracks[0]).toMatchObject({
      volume: 1,
      mixer: expect.objectContaining({ gainDb: -3 + linearToDb(0.5) }),
    });
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

  it('round-trips opaque SMF SysEx clip sidecars through a saved document', async () => {
    store.clips[0].smfSysEx = [
      { ppq: 0, status: 0xf0, data: [0x41, 0x10, 0x42, 0x12] },
      { ppq: 3.5, status: 0xf7, data: [0x7e, 0x7f, 0x09, 0x01] },
    ];
    const document = serializeProject();
    expect(document.tracks[0].clips[0].smfSysEx).toEqual(store.clips[0].smfSysEx);

    await loadProjectDocument(JSON.parse(JSON.stringify(document)) as ProjectDocument);
    expect(serializeProject()).toEqual(document);
  });

  it('round-trips a track live MIDI-FX transform through the document', async () => {
    const trackId = store.tracks[0].id;
    setTrackMidiFx(trackId, sanitizeMidiFxConfig({ transposeSemitones: 12, velocityScale: 1.5 }));
    const doc = serializeProject();
    expect(doc.tracks[0].midiFx).toMatchObject({ transposeSemitones: 12, velocityScale: 1.5 });

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(serializeProject()).toEqual(doc);
    expect(store.tracks[0].midiFx?.transposeSemitones).toBe(12);
  });

  it('round-trips the project External MIDI default and inherited tracks', async () => {
    const trackId = store.tracks[0].id;
    setProjectExternalMidiDefaultForTracks(
      { kind: 'external-midi', outputPortId: 'out-1', channel: 4, sendClock: true },
      [trackId],
    );
    const doc = serializeProject();
    expect(doc.externalMidiDefault).toEqual({
      kind: 'external-midi',
      outputPortId: 'out-1',
      channel: 4,
      sendClock: true,
    });
    expect(doc.tracks[0].externalMidiMode).toBe('project');

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(serializeProject()).toEqual(doc);
    expect(store.projectExternalMidi).toEqual(doc.externalMidiDefault);
    expect(store.tracks[0].externalMidiMode).toBe('project');
  });

  it('omits an identity track MIDI-FX transform from the document', async () => {
    const doc = serializeProject();
    // An identity transform injected into a loaded document never round-trips
    // back: loading drops the no-op so it stays out of the re-serialized doc.
    doc.tracks[0].midiFx = sanitizeMidiFxConfig({});
    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(serializeProject().tracks[0].midiFx).toBeUndefined();
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

  it('round-trips imported program-change and aftertouch lanes through the document', async () => {
    const doc = serializeProject();
    doc.tracks[0].clips[0].programChangeLanes = [
      {
        channel: 0,
        points: [
          { ppq: 0, program: 4 },
          { ppq: 1, program: 40 },
        ],
      },
    ];
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
    expect(store.activeClip?.programChangeLanes).toEqual(doc.tracks[0].clips[0].programChangeLanes);
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

  it('round-trips chord extensions without changing their display identity', async () => {
    setProjectChords([
      { startPpq: 0, endPpq: 4, rootPc: 0, quality: 11 },
      { startPpq: 4, endPpq: 8, rootPc: 2, quality: 6, extensions: [14] },
      { startPpq: 8, endPpq: 12, rootPc: 7, quality: 4, extensions: [13] },
      { startPpq: 12, endPpq: 16, rootPc: 5, quality: 4, extensions: [21] },
    ]);
    const doc = serializeProject();

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);

    expect(serializeProject()).toEqual(doc);
    expect(store.chords.map((chord) => formatChordName(chord))).toEqual([
      'Cm(add9)',
      'Dm9',
      'G7b9',
      'F13',
    ]);
  });

  // The annotation stream the Project stores has no field for omitted tones, so
  // a chord that leaves one out only survives because the document records it
  // and the read-back is seeded from what was written.
  it('round-trips chords that omit an intrinsic tone', async () => {
    setProjectChords([
      { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0, omissions: [4] },
      { startPpq: 4, endPpq: 8, rootPc: 7, quality: 4, extensions: [6], omissions: [7] },
      { startPpq: 8, endPpq: 12, rootPc: 5, quality: 4, extensions: [2, 5], omissions: [4] },
    ]);

    // Written, then read straight back out of the live Project.
    expect(store.chords.map((chord) => formatChordName(chord))).toEqual(['C5', 'G7b5', 'F11']);

    const doc = serializeProject();
    expect(doc.chords).toEqual([
      { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0, omissions: [4] },
      { startPpq: 4, endPpq: 8, rootPc: 7, quality: 4, extensions: [6], omissions: [7] },
      { startPpq: 8, endPpq: 12, rootPc: 5, quality: 4, extensions: [2, 5], omissions: [4] },
    ]);

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(serializeProject()).toEqual(doc);
    expect(store.chords).toEqual(doc.chords);
    expect(store.chords.map((chord) => formatChordName(chord))).toEqual(['C5', 'G7b5', 'F11']);
  });

  // A document written before omissions existed says nothing about them, and
  // must keep sounding every tone of its ordinal.
  it('reads a document with no omissions as sounding every intrinsic tone', async () => {
    setProjectChords([{ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 }]);
    const doc = serializeProject();
    expect(doc.chords?.[0]).not.toHaveProperty('omissions');

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(store.chords[0]?.omissions).toBeUndefined();
    expect(chordTonePitchClasses(store.chords[0] as EditorChordSymbol)).toEqual([0, 4, 7]);
  });

  // Seeding the read-back must not resurrect an omission the user just removed:
  // the seed only applies where the chord is otherwise unchanged.
  it('drops an omission when the chord at that position is rewritten without it', () => {
    setProjectChords([{ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0, omissions: [4] }]);
    expect(store.chords[0]?.omissions).toEqual([4]);

    setProjectChords([{ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 }]);
    expect(store.chords[0]?.omissions).toBeUndefined();
    expect(formatChordName(store.chords[0] as EditorChordSymbol)).toBe('C');
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

  it('round-trips a saved .szd through project load and re-serialization losslessly', async () => {
    buildSampleProject(store);
    const doc = serializeProject();
    const saved = encodeSzd(doc, { savedAt: '2026-07-04T00:00:00.000Z' });

    await loadProjectDocument(decodeSzd(saved));

    expect(serializeProject()).toEqual(doc);
  });

  it('round-trips curves on every MIDI expression lane', async () => {
    const clipId = store.clipId;
    setClipCcLane(clipId, 1, 2, [
      { ppq: 0, value: 0, curve: 'linear' },
      { ppq: 1, value: 127 },
    ]);
    setClipPitchBend(clipId, 3, [
      { ppq: 0, value: 8192, curve: 's-curve' },
      { ppq: 1, value: 12000 },
    ]);
    setClipChannelPressure(clipId, 4, [
      { ppq: 0, value: 20, curve: 'linear' },
      { ppq: 1, value: 80 },
    ]);
    setClipPolyPressure(clipId, 5, 60, [
      { ppq: 0, value: 30, curve: 's-curve' },
      { ppq: 1, value: 90 },
    ]);
    const doc = serializeProject();

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);

    expect(serializeProject()).toEqual(doc);
    expect(store.activeClip?.pitchBendLanes?.[0].points[0].curve).toBe('s-curve');
    expect(store.activeClip?.channelPressureLanes?.[0].points[0].curve).toBe('linear');
    expect(store.activeClip?.polyPressureLanes?.[0].points[0].curve).toBe('s-curve');
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

  it('round-trips MIDI-learn CC bindings, rebinding track scope across fresh ids', async () => {
    buildSampleProject(store);
    // Binding-less sessions omit the field entirely.
    expect(serializeProject().midiCcBindings).toBeUndefined();

    // Removing the first track leaves Bass with a non-contiguous id; the bound
    // target must still resolve after load (fresh ids are assigned on load).
    removeTrack(store.tracks[0].id);
    const bassTrackId = store.tracks.find((track) => track.name === 'Bass')?.id as number;
    store.midiCcBindings.set(`gain:${bassTrackId}`, { channel: 0, controller: 7 });
    store.midiCcBindings.set('gain:master', { channel: 1, controller: 10 });
    store.midiCcBindings.set(`pan:${bassTrackId}`, {
      channel: 2,
      controller: 6,
      kind: 'rpn',
      parameter: 2,
    });
    store.midiCcBindings.set(`strip:${bassTrackId}:inputTrimDb`, {
      channel: 3,
      controller: 24,
    });
    store.midiCcBindings.set(`send:${bassTrackId}:bus-1:enabled`, {
      channel: 4,
      controller: 31,
    });
    store.midiCcBindings.set(`track:${bassTrackId}:mute`, {
      channel: 5,
      controller: 33,
    });
    store.midiCcBindings.set('vca:drums:gain', {
      channel: 6,
      controller: 35,
    });
    store.midiCcBindings.set(`eq:${bassTrackId}:0:frequencyHz`, {
      channel: 7,
      controller: 38,
    });
    addMasteringProcessor('eq.tilt');
    const masteringProcessorId = store.mixer.masteringChain?.processors[0].id as string;
    const masteringTargetId = midiLearnMasteringTargetId(masteringProcessorId, 'tiltDb');
    store.midiCcBindings.set(masteringTargetId, {
      channel: 8,
      controller: 41,
    });
    const busId = addMixerBus({ name: 'FX' });
    const busStripTarget = midiLearnBusStripControlTargetId(busId, 'width');
    store.midiCcBindings.set(busStripTarget, { channel: 9, controller: 43 });
    // A binding to a track that no longer exists must drop out on serialize.
    store.midiCcBindings.set('pan:99999', { channel: 2, controller: 20 });

    const doc = serializeProject();
    expect(doc.midiCcBindings).toEqual([
      { target: busStripTarget, channel: 9, controller: 43 },
      { target: 'eq:0:0:frequencyHz', channel: 7, controller: 38, trackScoped: true },
      { target: 'gain:0', channel: 0, controller: 7, trackScoped: true },
      { target: 'gain:master', channel: 1, controller: 10 },
      { target: masteringTargetId, channel: 8, controller: 41 },
      { target: 'pan:0', channel: 2, controller: 6, kind: 'rpn', parameter: 2, trackScoped: true },
      { target: 'send:0:bus-1:enabled', channel: 4, controller: 31, trackScoped: true },
      { target: 'strip:0:inputTrimDb', channel: 3, controller: 24, trackScoped: true },
      { target: 'track:0:mute', channel: 5, controller: 33, trackScoped: true },
      { target: 'vca:drums:gain', channel: 6, controller: 35 },
    ]);
    // The document is plain JSON (the store map never leaks through).
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    const loadedBass = store.tracks.find((track) => track.name === 'Bass');
    expect(loadedBass).toBeDefined();
    expect(store.midiCcBindings.get(`gain:${loadedBass?.id}`)).toEqual({
      channel: 0,
      controller: 7,
    });
    expect(store.midiCcBindings.get('gain:master')).toEqual({ channel: 1, controller: 10 });
    expect(store.midiCcBindings.get(`pan:${loadedBass?.id}`)).toEqual({
      channel: 2,
      controller: 6,
      kind: 'rpn',
      parameter: 2,
    });
    expect(store.midiCcBindings.get(`strip:${loadedBass?.id}:inputTrimDb`)).toEqual({
      channel: 3,
      controller: 24,
    });
    expect(store.midiCcBindings.get(`send:${loadedBass?.id}:bus-1:enabled`)).toEqual({
      channel: 4,
      controller: 31,
    });
    expect(store.midiCcBindings.get(`track:${loadedBass?.id}:mute`)).toEqual({
      channel: 5,
      controller: 33,
    });
    expect(store.midiCcBindings.get('vca:drums:gain')).toEqual({
      channel: 6,
      controller: 35,
    });
    expect(store.midiCcBindings.get(`eq:${loadedBass?.id}:0:frequencyHz`)).toEqual({
      channel: 7,
      controller: 38,
    });
    expect(store.midiCcBindings.get(masteringTargetId)).toEqual({
      channel: 8,
      controller: 41,
    });
    expect(store.midiCcBindings.get(busStripTarget)).toEqual({ channel: 9, controller: 43 });
    expect(store.midiCcBindings.size).toBe(10);
    // Re-serializing the loaded project yields the same document.
    expect(serializeProject()).toEqual(doc);
  });

  it('round-trips session-wide transport and bank-slot bindings', async () => {
    buildSampleProject(store);
    store.midiCcBindings.set(midiLearnTransportTargetId('play'), { channel: 0, controller: 118 });
    store.midiCcBindings.set(midiLearnBankTargetId(2, 'gain'), { channel: 0, controller: 22 });
    store.midiCcBindings.set(midiLearnBankActionTargetId('next'), { channel: 0, controller: 47 });

    const doc = serializeProject();
    // These drive the session rather than a strip, so they are stored verbatim
    // instead of being rewritten to a positional track index.
    expect(doc.midiCcBindings).toContainEqual({
      target: 'transport:play',
      channel: 0,
      controller: 118,
    });
    expect(doc.midiCcBindings).toContainEqual({
      target: 'bank:2:gain',
      channel: 0,
      controller: 22,
    });

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);

    expect(store.midiCcBindings.get('transport:play')).toEqual({ channel: 0, controller: 118 });
    expect(store.midiCcBindings.get('bank:2:gain')).toEqual({ channel: 0, controller: 22 });
    expect(store.midiCcBindings.get('bank:next')).toEqual({ channel: 0, controller: 47 });
  });

  it('omits a default control surface and restores a configured one', async () => {
    buildSampleProject(store);
    // A third track leaves room for a two-strip window to sit off the first
    // track, which is what the offset round-trip has to prove.
    addTrack({ name: 'Keys' });
    expect(serializeProject().controlSurface).toBeUndefined();

    store.controlSurface = {
      protocol: 'mcu',
      bankSize: 2,
      bankOffset: 1,
      inputPortId: 'in-1',
      outputPortId: 'out-1',
      feedback: true,
    };
    const doc = serializeProject();
    expect(doc.controlSurface).toEqual(store.controlSurface);

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(store.controlSurface).toEqual({
      protocol: 'mcu',
      bankSize: 2,
      bankOffset: 1,
      inputPortId: 'in-1',
      outputPortId: 'out-1',
      feedback: true,
    });

    // A window saved on a larger session clamps onto a track that exists here.
    await loadProjectDocument({
      ...(JSON.parse(JSON.stringify(doc)) as ProjectDocument),
      controlSurface: { ...store.controlSurface, bankOffset: 400 },
    });
    expect(store.controlSurface.bankOffset).toBe(1);
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

  it('drops malformed document markers and sections before publishing the mirror', async () => {
    buildSampleProject(store);
    const doc = serializeProject();
    doc.markers = [
      { ppq: 4, name: 'Valid' },
      { ppq: -1, name: 'Before start' },
      { ppq: Number.NaN, name: 'Not finite' },
      { ppq: 8, name: 42 },
    ] as unknown as typeof doc.markers;
    doc.sections = [
      { name: 'Verse', color: '#112233', startPpq: 0, endPpq: 8 },
      { name: 'Reversed', color: '#112233', startPpq: 8, endPpq: 8 },
      { name: 'Negative', color: '#112233', startPpq: -1, endPpq: 4 },
      { name: 'Bad color', color: 1, startPpq: 8, endPpq: 16 },
    ] as unknown as typeof doc.sections;

    await loadProjectDocument(doc);

    expect(store.markers.map(({ ppq, name }) => ({ ppq, name }))).toEqual([
      { ppq: 4, name: 'Valid' },
    ]);
    expect(
      store.sections.map(({ name, color, startPpq, endPpq }) => ({
        name,
        color,
        startPpq,
        endPpq,
      })),
    ).toEqual([{ name: 'Verse', color: '#112233', startPpq: 0, endPpq: 8 }]);
  });

  it('rejects unsupported schema versions and keeps the open project alive', async () => {
    buildSampleProject(store);
    const doc = serializeProject();
    const bad = { ...doc, schemaVersion: 0 };
    await expect(loadProjectDocument(bad)).rejects.toThrow(/schema version/);
    const future = { ...doc, schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION + 1 };
    await expect(loadProjectDocument(future)).rejects.toThrow(/schema version/);
    // The previous project is untouched.
    expect(serializeProject()).toEqual(doc);
  });

  it('keeps the open project when a malformed document fails during mirror hydration', async () => {
    buildSampleProject(store);
    const before = serializeProject();
    const bad = JSON.parse(JSON.stringify(serializeProject())) as ProjectDocument;
    (bad as unknown as { mixer: unknown }).mixer = { master: {}, buses: {} };

    await expect(loadProjectDocument(bad)).rejects.toThrow();

    expect(store.initialized).toBe(true);
    expect(serializeProject()).toEqual(before);
  });

  it('validates mixer snapshots before publishing the replacement project', async () => {
    buildSampleProject(store);
    const before = serializeProject();
    const bad = JSON.parse(JSON.stringify(before)) as ProjectDocument;
    (bad as unknown as { mixerSnapshots: unknown }).mixerSnapshots = {};

    await expect(loadProjectDocument(bad)).rejects.toThrow();

    expect(store.initialized).toBe(true);
    expect(serializeProject()).toEqual(before);
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
    setClipCcLane(store.clipId, 1, 0, [{ ppq: 0, value: 64 }]);
    store.clips = store.clips.map((clip) =>
      clip.id === store.clipId
        ? { ...clip, smfSysEx: [{ ppq: 0, status: 0xf0, data: [0x7e, 0xf7] }] }
        : clip,
    );
    const result = exportProjectClipFile('demo');
    expect(result.filename).toBe('demo.midi2');
    expect(result.bytes.length).toBeGreaterThan(0);
    expect(result.midi2ClipLoss).toEqual({ expressionLanes: 1, sysExPackets: 1 });
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
            smfSysEx: [{ ppq: 0.25, status: 0xf0, data: [0x7e, 0x7f, 0x09] }],
          }
        : clip,
    );
    renameClip(store.clipId, 'Lead line');
    const result = await exportClipSmf(store.clipId);
    expect(result.filename).toBe('Lead line.mid');
    expect(Array.from(result.bytes.subarray(0, 4))).toEqual([0x4d, 0x54, 0x68, 0x64]);
    expect(extractSmfSysEx(result.bytes)).toEqual([
      { ppq: 0.25, status: 0xf0, data: [0x7e, 0x7f, 0x09] },
    ]);
    await expect(exportClipSmf(9999)).rejects.toThrow(RangeError);
  });
});
