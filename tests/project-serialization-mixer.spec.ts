import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { busAutomationTarget, insertAutomationParam } from '@/project/automation';
import {
  activeMixerSnapshotSlot,
  addAudioTrack,
  addGroupTrack,
  addInsert,
  addMasteringProcessor,
  addMixerBus,
  addVcaGroup,
  clearHistory,
  clearMixerSnapshots,
  exportMixerSnapshotSlots,
  mixerBusStripTarget,
  mixerSnapshotFilled,
  recallMixerSnapshot,
  saveMixerSnapshot,
  setAutomationLanePoints,
  setInsertSidechain,
  setMixerBusChannelLayout,
  setMixerSoloMode,
  setSend,
  setStripChannelDelaySamples,
  setStripDualPan,
  setStripEq,
  setStripGain,
  setStripOutputBus,
  setStripPan,
  setStripPanLaw,
  setStripPanMode,
  setTrackInstrument,
  setTrackPercussion,
  setTrackSoloSafe,
  setTrackVca,
  setVcaGroupMute,
  setVcaGroupSolo,
} from '@/project/commands';
import type { InsertSlot } from '@/project/mixer';
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

describe('project serialization with instruments and mixer (schema v4)', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('writes schema version 5', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBe(5);
    expect(serializeProject().schemaVersion).toBe(5);
  });

  it('omits instrument/mixer fields while everything is default', () => {
    const doc = serializeProject();
    expect(doc.mixer).toBeUndefined();
    for (const track of doc.tracks) {
      expect(track.instrument).toBeUndefined();
      expect(track.mixer).toBeUndefined();
    }
  });

  it('serializes instrument, strips and the project mixer state', async () => {
    const trackId = store.tracks[0].id;
    setTrackInstrument(trackId, { kind: 'sf2', fontId: 'gm-font', bank: 128, program: 25 });
    setStripGain(trackId, -4.5);
    setStripPan(trackId, 0.3);
    setStripPanLaw(trackId, 'const6Db');
    setStripPanMode(trackId, 'dualPan');
    setStripDualPan(trackId, -0.25, 0.5);
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
    expect(doc.tracks[0].mixer).toMatchObject({
      gainDb: -4.5,
      pan: 0.3,
      panLaw: 'const6Db',
      panMode: 'dualPan',
      dualPan: { left: -0.25, right: 0.5 },
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
    expect(doc.tracks[0].pan).toBe(0.3);
    expect(doc.mixer?.master.gainDb).toBe(-1.5);
    expect(doc.mixer?.buses).toEqual([{ id: busId, name: 'FX', gainDb: 0 }]);

    // JSON round-trip stays lossless (plain data only).
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);

    await loadProjectDocument(doc);
    expect(store.tracks[0].mixer?.panLaw).toBe('const6Db');
    expect(store.tracks[0].mixer?.panMode).toBe('dualPan');
    expect(store.tracks[0].mixer?.dualPan).toEqual({ left: -0.25, right: 0.5 });
    expect(store.tracks[0].pan).toBe(0.3);
  });

  it('promotes legacy track pan into the audible strip and preserves group pan on load', async () => {
    const legacy = serializeProject();
    legacy.tracks[0].pan = -0.6;
    delete legacy.tracks[0].mixer;
    legacy.tracks.push({
      name: 'Group',
      color: '#888888',
      kind: 'group',
      mute: false,
      solo: false,
      volume: 1,
      pan: 0.8,
      mixer: { gainDb: -3, pan: 0.8, inserts: [], sends: [] },
      automation: [{ param: 'pan', enabled: true, points: [{ ppq: 0, value: 0.5 }] }],
      clips: [],
    });

    await loadProjectDocument(legacy);

    expect(store.tracks[0]).toMatchObject({ pan: -0.6, mixer: { pan: -0.6 } });
    expect(store.tracks[1]).toMatchObject({ pan: 0.8, mixer: { gainDb: -3, pan: 0.8 } });
    expect(store.automationLanes.some((lane) => lane.target === store.tracks[1].id)).toBe(false);
    const saved = serializeProject();
    expect(saved.tracks[0]).toMatchObject({ pan: -0.6, mixer: { pan: -0.6 } });
    expect(saved.tracks[1]).toMatchObject({ pan: 0.8, mixer: { gainDb: -3, pan: 0.8 } });
  });

  it('loads schema-4 retired processor ids under their current catalog id everywhere they are stored', async () => {
    const trackId = store.tracks[0].id;
    addInsert(trackId, 'eq.passiveTube');
    addInsert('master', 'eq.steppedProportionalQ');
    addMasteringProcessor('eq.passiveTube');
    saveMixerSnapshot('A');
    const legacy = JSON.parse(
      JSON.stringify(serializeProject())
        .replaceAll('"eq.passiveTube"', '"eq.pultec"')
        .replaceAll('"eq.steppedProportionalQ"', '"eq.apiStyle"'),
    ) as ProjectDocument;
    legacy.schemaVersion = 4;
    expect(JSON.stringify(legacy)).toContain('"eq.pultec"');

    await loadProjectDocument(legacy);

    const saved = JSON.stringify(serializeProject());
    expect(saved).not.toContain('"eq.pultec"');
    expect(saved).not.toContain('"eq.apiStyle"');
    expect(store.tracks[0].mixer?.inserts[0].processor).toBe('eq.passiveTube');
    expect(saved.match(/"eq\.passiveTube"/g)?.length).toBe(4);
    expect(saved.match(/"eq\.steppedProportionalQ"/g)?.length).toBe(2);
  });

  it('rejects a track instrument the instrument commands would refuse', async () => {
    const doc = serializeProject();
    doc.tracks[0].instrument = { kind: 'synth-patch', patch: { gain: 5 } };
    await expect(loadProjectDocument(doc)).rejects.toThrow(/gain must be a finite number/);
    doc.tracks[0].instrument = { kind: 'sf2', fontId: 'gm-font', program: 128 };
    await expect(loadProjectDocument(doc)).rejects.toThrow(/SF2 program/);
  });

  it('rejects group pan automation commands', () => {
    const groupId = addGroupTrack({ name: 'Group' });
    expect(() => setAutomationLanePoints(groupId, 'pan', [{ ppq: 0, value: 0.5 }])).toThrow(
      /Group bus pan automation is not supported/,
    );
  });

  it('drops legacy master sends on save and load because they are not audible', async () => {
    const busId = addMixerBus({ name: 'FX' });
    store.mixer.master.sends = [{ busId, levelDb: -6, enabled: true }];

    const doc = serializeProject();
    expect(doc.mixer?.master.sends).toEqual([]);

    const legacyDoc = JSON.parse(JSON.stringify(doc)) as ProjectDocument;
    legacyDoc.mixer!.master.sends = [{ busId, levelDb: -6, enabled: true }];
    await loadProjectDocument(legacyDoc);
    expect(store.mixer.master.sends).toEqual([]);
    expect(serializeProject().mixer?.master.sends).toEqual([]);
  });

  it('round-trips mixer solo audition mode and normalizes invalid documents', async () => {
    setMixerSoloMode('pfl');
    const doc = serializeProject();
    expect(doc.mixer?.soloMode).toBe('pfl');

    await loadProjectDocument(doc);
    expect(store.mixer.soloMode).toBe('pfl');

    const invalid = JSON.parse(JSON.stringify(doc)) as ProjectDocument;
    invalid.mixer!.soloMode = 'bad-mode' as never;
    await loadProjectDocument(invalid);
    expect(store.mixer.soloMode).toBeUndefined();
    expect(serializeProject().mixer?.soloMode).toBeUndefined();
  });

  it('round-trips: load + re-serialize yields the same document', async () => {
    const trackId = store.tracks[0].id;
    setTrackInstrument(trackId, { kind: 'synth-patch', patch: { preset: 'sawLead', drive: 0.4 } });
    setStripGain(trackId, -3);
    addInsert('master', 'maximizer.maximizer');
    const doc = serializeProject();

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(serializeProject()).toEqual(doc);
    expect(store.tracks[0].instrument).toEqual({
      kind: 'synth-patch',
      patch: { preset: 'sawLead', drive: 0.4 },
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

  it('round-trips group-bus sidechain references by document track index', async () => {
    const sourceGroupId = addGroupTrack({ name: 'Key group' });
    const targetGroupId = addGroupTrack({ name: 'Ducker group' });
    addInsert(targetGroupId, 'dynamics.sidechainRouter');
    setInsertSidechain(targetGroupId, 0, { kind: 'group', trackId: sourceGroupId });

    const doc = serializeProject();
    const targetEntry = doc.tracks.find((track) => track.name === 'Ducker group');
    const serializedInsert = targetEntry?.mixer?.inserts[0] as
      | (InsertSlot & { sidechainSourceGroupTrackIndex?: number })
      | undefined;
    expect(serializedInsert).toMatchObject({
      sidechainSourceGroupTrackIndex: 1,
    });
    expect(serializedInsert?.sidechainSourceGroupTrackId).toBeUndefined();

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    const loadedSource = store.tracks.find((track) => track.name === 'Key group');
    const loadedTarget = store.tracks.find((track) => track.name === 'Ducker group');
    expect(loadedTarget?.mixer?.inserts[0].sidechainSourceGroupTrackId).toBe(loadedSource?.id);
  });

  it('migrates legacy group track keys or rejects them on ordinary tracks', async () => {
    const sourceGroupId = addGroupTrack({ name: 'Key group' });
    const sourceGroupIndex = store.tracks.findIndex((track) => track.id === sourceGroupId);
    addInsert(store.tracks[0].id, 'dynamics.compressor');
    const ordinaryDoc = serializeProject();
    const ordinarySlot = ordinaryDoc.tracks[0]!.mixer!.inserts[0] as InsertSlot & {
      sidechainSourceIndex?: number;
    };
    ordinarySlot.sidechainSourceIndex = sourceGroupIndex;
    await expect(loadProjectDocument(ordinaryDoc)).rejects.toThrow(/group sidechain key/);

    const targetGroupId = addGroupTrack({ name: 'Ducker group' });
    addInsert(targetGroupId, 'dynamics.compressor');
    const groupDoc = serializeProject();
    const targetEntry = groupDoc.tracks.find((track) => track.name === 'Ducker group')!;
    const groupSlot = targetEntry.mixer!.inserts[0] as InsertSlot & {
      sidechainSourceIndex?: number;
      sidechainSourceGroupTrackIndex?: number;
    };
    delete groupSlot.sidechainSourceGroupTrackIndex;
    groupSlot.sidechainSourceIndex = sourceGroupIndex;

    await loadProjectDocument(groupDoc);
    const loadedSource = store.tracks.find((track) => track.name === 'Key group');
    const loadedTarget = store.tracks.find((track) => track.name === 'Ducker group');
    expect(loadedTarget?.mixer?.inserts[0].sidechainSourceGroupTrackId).toBe(loadedSource?.id);
    expect(loadedTarget?.mixer?.inserts[0].sidechainSourceTrackId).toBeUndefined();
  });

  it('rejects duplicate, empty and reserved mixer bus ids while loading', async () => {
    const cases = [
      { id: '', message: /must not be empty/ },
      { id: 'group:1', message: /reserved/ },
      { id: 'master', message: /reserved/ },
      { id: 'return-solo-discard', message: /reserved/ },
    ] as const;
    for (const [index, entry] of cases.entries()) {
      addMixerBus({ id: `room-${index}` });
      const doc = serializeProject();
      doc.mixer!.buses[0].id = entry.id;
      await expect(loadProjectDocument(doc)).rejects.toThrow(entry.message);
    }

    addMixerBus({ id: 'room' });
    const duplicateDoc = serializeProject();
    duplicateDoc.mixer!.buses.push({ ...duplicateDoc.mixer!.buses[0] });
    await expect(loadProjectDocument(duplicateDoc)).rejects.toThrow(/already exists/);
  });

  it('round-trips bus sends, output routing, surround layout and bus sidechains', async () => {
    const sourceBusId = addMixerBus({ name: 'Key' });
    const targetBusId = addMixerBus({ name: 'Target' });
    const outputBusId = addMixerBus({ name: 'Output' });
    setMixerBusChannelLayout(targetBusId, '5.1');
    store.mixer.masterLayout = '7.1';
    const target = mixerBusStripTarget(targetBusId);
    setSend(target, outputBusId, { levelDb: -9, timing: 'preFader' });
    setStripOutputBus(target, outputBusId);
    addInsert(target, 'dynamics.compressor');
    setInsertSidechain(target, 0, { kind: 'bus', busId: sourceBusId });
    addInsert('master', 'dynamics.compressor');
    setInsertSidechain('master', 0, { kind: 'bus', busId: sourceBusId });
    const sourceStrip = store.mixer.buses.find((bus) => bus.id === sourceBusId)?.strip;
    if (sourceStrip) {
      sourceStrip.surroundPan = {
        azimuth: 45,
        elevation: 0,
        divergence: 0.25,
        lfe: 0.2,
        distance: 1,
      };
    }

    const doc = serializeProject();
    expect(doc.mixer?.buses).toMatchObject([
      { id: sourceBusId, name: 'Key', gainDb: 0 },
      {
        id: targetBusId,
        channelLayout: '5.1',
        strip: {
          outputBusId,
          sends: [{ busId: outputBusId, levelDb: -9, enabled: true, timing: 'preFader' }],
          inserts: [{ sidechainSourceBusId: sourceBusId }],
        },
      },
      { id: outputBusId, name: 'Output', gainDb: 0 },
    ]);
    expect(doc.mixer?.master.inserts[0]).toMatchObject({
      sidechainSourceBusId: sourceBusId,
    });
    expect(doc.mixer?.masterLayout).toBe('7.1');

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    const loadedTarget = store.mixer.buses.find((bus) => bus.id === targetBusId);
    expect(loadedTarget?.channelLayout).toBe('5.1');
    expect(loadedTarget?.strip).toMatchObject({
      outputBusId,
      sends: [{ busId: outputBusId, timing: 'preFader' }],
      inserts: [{ sidechainSourceBusId: sourceBusId }],
    });
    expect(store.mixer.masterLayout).toBe('7.1');
    expect(store.mixer.master.inserts[0].sidechainSourceBusId).toBe(sourceBusId);
  });

  it('round-trips a bus return insert chain through the document', async () => {
    const busId = addMixerBus({ name: 'FX' });
    addInsert(mixerBusStripTarget(busId), 'dynamics.compressor', { thresholdDb: -18 });
    const doc = serializeProject();

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);

    expect(serializeProject()).toEqual(doc);
    expect(store.mixer.buses[0].strip?.inserts).toMatchObject([
      { processor: 'dynamics.compressor', params: { thresholdDb: -18 }, enabled: true },
    ]);
  });

  it('round-trips return-bus pan modes and EQ through the document', async () => {
    const busId = addMixerBus({ name: 'FX' });
    const target = mixerBusStripTarget(busId);
    setStripPan(target, -0.25);
    setStripPanLaw(target, 'const6Db');
    setStripPanMode(target, 'dualPan');
    setStripDualPan(target, -1, 0.6);
    setStripEq(target, {
      enabled: true,
      bands: [{ type: 'Peak', frequencyHz: 1500, gainDb: 2.5 }],
    });

    const doc = serializeProject();
    expect(doc.mixer?.buses[0].strip).toMatchObject({
      pan: -0.25,
      panLaw: 'const6Db',
      panMode: 'dualPan',
      dualPan: { left: -1, right: 0.6 },
      eq: { enabled: true, bands: [{ type: 'Peak', frequencyHz: 1500, gainDb: 2.5 }] },
    });

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(store.mixer.buses[0].strip).toMatchObject({
      pan: -0.25,
      panLaw: 'const6Db',
      panMode: 'dualPan',
      dualPan: { left: -1, right: 0.6 },
      eq: { enabled: true, bands: [{ type: 'Peak', frequencyHz: 1500, gainDb: 2.5 }] },
    });
  });

  it('round-trips bus gain automation through the bus document entry', async () => {
    const busId = addMixerBus({ name: 'FX' });
    const target = busAutomationTarget(busId);
    setAutomationLanePoints(target, 'faderDb', [
      { ppq: 0, value: -12 },
      { ppq: 960, value: -3, curve: 'hold' },
    ]);
    const doc = serializeProject();

    expect(doc.mixer?.buses[0].automation).toEqual([
      {
        param: 'faderDb',
        enabled: true,
        points: [
          { ppq: 0, value: -12 },
          { ppq: 960, value: -3, curve: 'hold' },
        ],
      },
    ]);

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(store.automationLanes).toEqual([
      {
        target,
        param: 'faderDb',
        enabled: true,
        points: [
          { ppq: 0, value: -12 },
          { ppq: 960, value: -3, curve: 'hold' },
        ],
      },
    ]);
    expect(serializeProject()).toEqual(doc);
  });

  it('round-trips mixer-scope sidechain ids positionally', async () => {
    const sourceId = addAudioTrack({ name: 'Kick' });
    const busId = addMixerBus({ name: 'FX' });
    addInsert(mixerBusStripTarget(busId), 'dynamics.compressor', { thresholdDb: -18 });
    store.mixer.buses[0].strip!.inserts[0].sidechainSourceTrackId = sourceId;
    addInsert('master', 'dynamics.compressor', { thresholdDb: -18 });
    store.mixer.master.inserts[0].sidechainSourceTrackId = sourceId;

    const doc = serializeProject();
    const sourceIndex = doc.tracks.findIndex((track) => track.name === 'Kick');
    const busSlot = doc.mixer?.buses[0].strip?.inserts[0] as
      | (InsertSlot & { sidechainSourceIndex?: number })
      | undefined;
    const masterSlot = doc.mixer?.master.inserts[0] as
      | (InsertSlot & { sidechainSourceIndex?: number })
      | undefined;

    expect(busSlot?.sidechainSourceTrackId).toBeUndefined();
    expect(masterSlot?.sidechainSourceTrackId).toBeUndefined();
    expect(busSlot?.sidechainSourceIndex).toBe(sourceIndex);
    expect(masterSlot?.sidechainSourceIndex).toBe(sourceIndex);

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);

    const reloadedSourceId = store.tracks[sourceIndex].id;
    expect(store.mixer.buses[0].strip?.inserts[0].sidechainSourceTrackId).toBe(reloadedSourceId);
    expect(store.mixer.master.inserts[0].sidechainSourceTrackId).toBe(reloadedSourceId);
    expect(
      (store.mixer.buses[0].strip!.inserts[0] as InsertSlot & { sidechainSourceIndex?: number })
        .sidechainSourceIndex,
    ).toBeUndefined();
    expect(
      (store.mixer.master.inserts[0] as InsertSlot & { sidechainSourceIndex?: number })
        .sidechainSourceIndex,
    ).toBeUndefined();
  });

  it('resolves mixer-scope sidechain indices when store.loadDocument is called directly', async () => {
    const sourceId = addAudioTrack({ name: 'Kick' });
    const busId = addMixerBus({ name: 'FX' });
    addInsert(mixerBusStripTarget(busId), 'dynamics.compressor');
    store.mixer.buses[0].strip!.inserts[0].sidechainSourceTrackId = sourceId;
    addInsert('master', 'dynamics.compressor');
    store.mixer.master.inserts[0].sidechainSourceTrackId = sourceId;

    const doc = JSON.parse(JSON.stringify(serializeProject())) as ProjectDocument;
    const sourceIndex = doc.tracks.findIndex((track) => track.name === 'Kick');

    await store.loadDocument(doc);

    const reloadedSourceId = store.tracks[sourceIndex].id;
    expect(store.mixer.buses[0].strip?.inserts[0].sidechainSourceTrackId).toBe(reloadedSourceId);
    expect(store.mixer.master.inserts[0].sidechainSourceTrackId).toBe(reloadedSourceId);
    expect(
      (store.mixer.buses[0].strip!.inserts[0] as InsertSlot & { sidechainSourceIndex?: number })
        .sidechainSourceIndex,
    ).toBeUndefined();
    expect(
      (store.mixer.master.inserts[0] as InsertSlot & { sidechainSourceIndex?: number })
        .sidechainSourceIndex,
    ).toBeUndefined();
  });

  it('round-trips a pre-fader send and a channel alignment delay', async () => {
    const trackId = store.tracks[0].id;
    const busId = addMixerBus({ name: 'FX' });
    setSend(trackId, busId, { levelDb: -6, enabled: true, timing: 'preFader' });
    setStripChannelDelaySamples(trackId, 192);
    const doc = serializeProject();

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(serializeProject()).toEqual(doc);
    expect(store.tracks[0].mixer?.sends[0].timing).toBe('preFader');
    expect(store.tracks[0].mixer?.channelDelaySamples).toBe(192);
  });

  it('round-trips VCA groups and the per-track solo-safe / VCA assignment', async () => {
    const trackId = store.tracks[0].id;
    const groupId = addVcaGroup({ name: 'Drums' });
    setTrackVca(trackId, groupId);
    setTrackSoloSafe(trackId, true);
    setVcaGroupMute(groupId, true);
    setVcaGroupSolo(groupId, true);
    const doc = serializeProject();

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(serializeProject()).toEqual(doc);
    expect(store.mixer.vcaGroups).toEqual([
      { id: groupId, name: 'Drums', gainDb: 0, mute: true, solo: true },
    ]);
    expect(store.tracks[0].vcaId).toBe(groupId);
    expect(store.tracks[0].soloSafe).toBe(true);
  });

  it('round-trips the explicit percussion override in both states', async () => {
    addAudioTrack({ name: 'Second' });
    const [a, b] = store.tracks;
    setTrackPercussion(a.id, true);
    setTrackPercussion(b.id, false);
    const doc = serializeProject();

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(serializeProject()).toEqual(doc);
    expect(store.tracks[0].percussion).toBe(true);
    expect(store.tracks[1].percussion).toBe(false);
  });

  it('persists mixer snapshot slots with document-track-index bindings', async () => {
    const trackId = store.tracks[0].id;
    addInsert(trackId, 'saturation.tape', { drive: 0.4 });
    const processorId = store.tracks[0].mixer?.inserts[0].id as string;
    store.automationLanes = [
      {
        target: trackId,
        param: insertAutomationParam(processorId, 'drive'),
        points: [{ ppq: 0, value: 0.7 }],
        enabled: true,
      },
    ];
    setStripGain(trackId, -5);
    saveMixerSnapshot('D');
    setStripGain(trackId, 3);
    const doc = serializeProject();

    expect(doc.mixerSnapshots?.active).toBe('D');
    expect(doc.mixerSnapshots?.slots.D?.tracks[0]).toMatchObject({
      trackIndex: 0,
      mute: false,
      solo: false,
    });
    expect((doc.mixerSnapshots!.slots.D!.tracks[0] as { id?: unknown }).id).toBeUndefined();
    expect(doc.mixerSnapshots?.slots.D?.automationLanes?.[0]).toMatchObject({
      target: 0,
      param: insertAutomationParam(processorId, 'drive'),
    });

    clearMixerSnapshots();
    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(mixerSnapshotFilled('D')).toBe(true);
    expect(activeMixerSnapshotSlot()).toBe('D');

    const loadedTrackId = store.tracks[0].id;
    expect(exportMixerSnapshotSlots().snapshots.D?.automationLanes?.[0]?.target).toBe(
      loadedTrackId,
    );
    setStripGain(loadedTrackId, 12);
    store.automationLanes = [];
    expect(recallMixerSnapshot('D')).toBe(true);
    expect(store.tracks[0].mixer?.gainDb).toBe(-5);
    expect(store.automationLanes).toEqual([
      {
        target: loadedTrackId,
        param: insertAutomationParam(processorId, 'drive'),
        points: [{ ppq: 0, value: 0.7 }],
        enabled: true,
      },
    ]);
  });

  it('preserves group-track insert sidechain sources in mixer snapshot slots', async () => {
    const sourceId = store.tracks[0].id;
    const groupId = addGroupTrack({ name: 'Group' });
    addInsert(groupId, 'dynamics.compressor', { thresholdDb: -12 });
    const group = store.tracks.find((track) => track.id === groupId)!;
    group.mixer!.inserts[0].sidechainSourceTrackId = sourceId;

    saveMixerSnapshot('D');
    const doc = serializeProject();
    const groupIndex = doc.tracks.findIndex((track) => track.kind === 'group');
    const snapshotTrack = doc.mixerSnapshots?.slots.D?.tracks.find(
      (entry) => entry.trackIndex === groupIndex,
    );
    const snapshotSlot = snapshotTrack?.mixer.inserts[0] as
      | (InsertSlot & { sidechainSourceIndex?: number })
      | undefined;

    expect(snapshotSlot?.sidechainSourceTrackId).toBeUndefined();
    expect(snapshotSlot?.sidechainSourceIndex).toBe(0);

    clearMixerSnapshots();
    await loadProjectDocument(JSON.parse(JSON.stringify(doc)) as ProjectDocument);
    expect(recallMixerSnapshot('D')).toBe(true);
    const loadedGroup = store.tracks.find((track) => track.kind === 'group');
    expect(loadedGroup?.mixer?.inserts[0].sidechainSourceTrackId).toBe(sourceId);
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
    // Pre-v4 files keep the e-piano they were written against.
    expect(store.tracks[0].instrument).toEqual({ kind: 'synth-preset', preset: 'ePiano' });
    expect(store.tracks[0].mixer).toBeUndefined();
    expect(store.mixer).toEqual({
      master: { gainDb: 0, pan: 0, inserts: [], sends: [] },
      buses: [],
    });
    // Re-serializing upgrades to the current schema.
    expect(serializeProject().schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
  });

  it('leaves current documents on the current default instrument', async () => {
    const doc = serializeProject();
    for (const track of doc.tracks) delete track.instrument;
    const before = JSON.stringify(doc);

    await loadProjectDocument(doc);

    expect(JSON.stringify(doc)).toBe(before);
    expect(store.tracks[0].instrument).toBeUndefined();
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
    expect(byName.get('Drums')).toEqual({ kind: 'synth-preset', preset: 'drumKit' });
    expect(byName.get('Bass')).toEqual({ kind: 'synth-preset', preset: 'subBass' });
    expect(byName.get('Piano')).toEqual({ kind: 'synth-preset', preset: 'acousticPiano' });
    expect(byName.get('Guitar')).toEqual({ kind: 'synth-preset', preset: 'electricGuitar' });
  });

  it('gm-orchestra routes percussion to a percussion-capable preset', () => {
    const tracks = createTemplate('gm-orchestra').tracks;
    const percussion = tracks.filter((t) => t.name === 'Timpani' || t.name === 'Percussion');
    expect(percussion).toHaveLength(2);
    for (const track of percussion) {
      expect(track.instrument).toEqual({ kind: 'synth-preset', preset: 'drumKit' });
    }
    // Every orchestral track carries some instrument.
    for (const track of tracks) {
      expect(track.instrument?.kind).toBe('synth-preset');
    }
  });

  it('programming assigns synth-oriented presets', () => {
    const byName = new Map(createTemplate('programming').tracks.map((t) => [t.name, t.instrument]));
    expect(byName.get('Lead Synth')).toEqual({ kind: 'synth-preset', preset: 'sawLead' });
    expect(byName.get('Synth Bass')).toEqual({ kind: 'synth-preset', preset: 'subBass' });
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
