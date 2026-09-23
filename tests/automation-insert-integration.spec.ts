import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  busAutomationTarget,
  insertAutomationParam,
  instrumentAutomationParam,
  masteringAutomationParam,
} from '@/project/automation';
import {
  addInsert,
  addMasteringProcessor,
  addMixerBus,
  clearHistory,
  setAutomationLanePoints,
  setTrackInstrument,
} from '@/project/commands';
import {
  loadProjectDocument,
  type ProjectDocument,
  serializeProject,
} from '@/project/serialization';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('insert automation command validation', () => {
  let store: ReturnType<typeof useProjectStore>;
  let trackId: number;
  let busId: string;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    trackId = store.tracks[0].id;
    busId = addMixerBus({ name: 'FX' });
    addInsert(trackId, 'gain.gain');
    addInsert('master', 'gain.gain');
    addInsert(busAutomationTarget(busId), 'gain.gain');
  });

  it('accepts an insert lane on a track, master and bus', () => {
    expect(() =>
      setAutomationLanePoints(trackId, insertAutomationParam(0, 'gainDb'), [{ ppq: 0, value: 1 }]),
    ).not.toThrow();
    expect(() =>
      setAutomationLanePoints('master', insertAutomationParam(0, 'gainDb'), [{ ppq: 0, value: 1 }]),
    ).not.toThrow();
    expect(() =>
      setAutomationLanePoints(busAutomationTarget(busId), insertAutomationParam(0, 'gainDb'), [
        { ppq: 0, value: 1 },
      ]),
    ).not.toThrow();
    expect(store.automationLanes).toHaveLength(3);
  });

  it('rejects an insert lane whose slot index is out of range', () => {
    expect(() =>
      setAutomationLanePoints(trackId, insertAutomationParam(5, 'gainDb'), [{ ppq: 0, value: 1 }]),
    ).toThrow(RangeError);
  });

  it('still rejects a non-fader, non-insert lane on a bus', () => {
    expect(() =>
      setAutomationLanePoints(busAutomationTarget(busId), 'pan', [{ ppq: 0, value: 0 }]),
    ).toThrow(/only support fader/);
  });

  it('accepts mastering automation only on an existing master-chain processor', () => {
    addMasteringProcessor('maximizer.truePeakLimiter', { ceilingDb: -1 });
    expect(() =>
      setAutomationLanePoints('master', masteringAutomationParam(0, 'ceilingDb'), [
        { ppq: 0, value: -2 },
      ]),
    ).not.toThrow();
    expect(() =>
      setAutomationLanePoints(trackId, masteringAutomationParam(0, 'ceilingDb'), [
        { ppq: 0, value: -2 },
      ]),
    ).toThrow(/must target the master/);
    expect(() =>
      setAutomationLanePoints('master', masteringAutomationParam(9, 'ceilingDb'), [
        { ppq: 0, value: -2 },
      ]),
    ).toThrow(/Unknown mastering processor/);
  });

  it('accepts instrument automation only on NativeSynth MIDI tracks and automatable fields', () => {
    const lane =
      (param = instrumentAutomationParam('cutoffHz')) =>
      () =>
        setAutomationLanePoints(trackId, param, [{ ppq: 0, value: 1200 }]);
    setTrackInstrument(trackId, { kind: 'synth-patch', patch: { preset: 'saw-lead' } });
    expect(lane()).not.toThrow();
    setTrackInstrument(trackId, { kind: 'synth-preset', preset: 'saw-lead' });
    expect(lane()).not.toThrow();
    expect(lane(instrumentAutomationParam('unison'))).toThrow(/not automatable/);
    setTrackInstrument(trackId, { kind: 'sf2', fontId: 'gm' });
    expect(lane()).toThrow(/synth instrument/);
    expect(() =>
      setAutomationLanePoints('master', instrumentAutomationParam('cutoffHz'), [
        { ppq: 0, value: 1200 },
      ]),
    ).toThrow(/MIDI track/);
  });
});

describe('insert automation serialization', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('round-trips track, master and bus insert lanes', async () => {
    const trackId = store.tracks[0].id;
    const busId = addMixerBus({ name: 'FX' });
    addInsert(trackId, 'gain.gain');
    addInsert('master', 'gain.gain');
    addInsert(busAutomationTarget(busId), 'gain.gain');
    addMasteringProcessor('maximizer.truePeakLimiter', { ceilingDb: -1 });
    setTrackInstrument(trackId, { kind: 'synth-patch', patch: { preset: 'saw-lead' } });
    setAutomationLanePoints(trackId, insertAutomationParam(0, 'gainDb'), [{ ppq: 0, value: 2 }]);
    setAutomationLanePoints(trackId, instrumentAutomationParam('cutoffHz'), [
      { ppq: 2, value: 1800 },
    ]);
    setAutomationLanePoints('master', insertAutomationParam(0, 'gainDb'), [{ ppq: 4, value: -3 }]);
    setAutomationLanePoints(busAutomationTarget(busId), insertAutomationParam(0, 'gainDb'), [
      { ppq: 8, value: 5 },
    ]);
    setAutomationLanePoints('master', masteringAutomationParam(0, 'ceilingDb'), [
      { ppq: 12, value: -2 },
    ]);

    const doc = serializeProject();
    await loadProjectDocument(doc);

    const reTrackId = store.tracks[0].id;
    const reBusId = store.mixer.buses[0].id;
    const trackProcessorId = store.tracks[0].mixer?.inserts[0].id;
    const masterProcessorId = store.mixer.master.inserts[0].id;
    const busProcessorId = store.mixer.buses[0].strip?.inserts[0].id;
    const masteringProcessorId = store.mixer.masteringChain?.processors[0].id;
    expect(trackProcessorId).toBeTruthy();
    expect(masterProcessorId).toBeTruthy();
    expect(busProcessorId).toBeTruthy();
    expect(masteringProcessorId).toBeTruthy();
    const keyed = store.automationLanes.map((lane) => `${lane.target}:${lane.param}`).sort();
    expect(keyed).toEqual(
      [
        `${reTrackId}:${insertAutomationParam(trackProcessorId as string, 'gainDb')}`,
        `${reTrackId}:${instrumentAutomationParam('cutoffHz')}`,
        `master:${insertAutomationParam(masterProcessorId as string, 'gainDb')}`,
        `master:${masteringAutomationParam(masteringProcessorId as string, 'ceilingDb')}`,
        `${busAutomationTarget(reBusId)}:${insertAutomationParam(busProcessorId as string, 'gainDb')}`,
      ].sort(),
    );
  });

  it('prunes a loaded insert lane whose slot exceeds the strip insert count', async () => {
    const trackId = store.tracks[0].id;
    addInsert(trackId, 'gain.gain');
    setAutomationLanePoints(trackId, insertAutomationParam(0, 'gainDb'), [{ ppq: 0, value: 1 }]);
    const doc = serializeProject();
    // Inject an out-of-range insert lane into the document track entry.
    (doc.tracks[0].automation ?? []).push({
      param: insertAutomationParam(3, 'gainDb'),
      points: [{ ppq: 0, value: 1 }],
      enabled: true,
    });

    await loadProjectDocument(doc);

    const params = store.automationLanes.map((lane) => lane.param);
    expect(params).toContain(
      insertAutomationParam(store.tracks[0].mixer?.inserts[0].id as string, 'gainDb'),
    );
    expect(params).not.toContain(insertAutomationParam(3, 'gainDb'));
  });

  it('leaves a fader/pan-only document byte-stable across a round-trip', async () => {
    const trackId = store.tracks[0].id;
    setAutomationLanePoints(trackId, 'faderDb', [{ ppq: 0, value: -6 }]);
    setAutomationLanePoints('master', 'pan', [{ ppq: 4, value: 0.5 }]);
    const before = JSON.stringify(serializeProject());
    await loadProjectDocument(JSON.parse(before) as ProjectDocument);
    expect(JSON.stringify(serializeProject())).toBe(before);
  });
});
