import type { MasteringPreset, SoloProcessor } from '@libraz/libsonare';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { masteringAutomationParam } from '@/project/automation';
import {
  addMasteringProcessor,
  applyMasteringPresetWithOverrides,
  clearHistory,
  redo,
  removeMasteringProcessor,
  reorderMasteringProcessor,
  setMasteringEnabled,
  setMasteringParam,
  setMasteringPreset,
  setStripGain,
  undo,
} from '@/project/commands';
import {
  createDefaultMasteringChain,
  isDefaultMasteringChain,
  isDefaultMixerState,
  masteringChainIsActive,
} from '@/project/mixer';
import { loadProjectDocument, serializeProject } from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { midiLearnMasteringTargetId } from '@/ui/midi/midi-learn';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('mastering chain model helpers', () => {
  it('treats an absent or empty chain as default', () => {
    expect(isDefaultMasteringChain(undefined)).toBe(true);
    expect(isDefaultMasteringChain(createDefaultMasteringChain())).toBe(true);
    expect(isDefaultMasteringChain({ preset: 'pop', processors: [] })).toBe(false);
    expect(
      isDefaultMasteringChain({
        processors: [{ processor: 'eq.tilt', params: {}, enabled: true }],
      }),
    ).toBe(false);
  });

  it('reports activity only for presets or enabled processors', () => {
    expect(masteringChainIsActive(undefined)).toBe(false);
    expect(masteringChainIsActive({ processors: [] })).toBe(false);
    expect(masteringChainIsActive({ preset: 'pop', processors: [] })).toBe(true);
    expect(
      masteringChainIsActive({
        processors: [{ processor: 'eq.tilt', params: {}, enabled: false }],
      }),
    ).toBe(false);
    expect(
      masteringChainIsActive({
        processors: [{ processor: 'eq.tilt', params: {}, enabled: true }],
      }),
    ).toBe(true);
  });
});

describe('mastering chain commands', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('adds, undoes and redoes a processor as one edit', () => {
    const index = addMasteringProcessor('maximizer.truePeakLimiter', { ceilingDbtp: -1 });
    expect(index).toBe(0);
    expect(store.mixer.masteringChain?.processors).toMatchObject([
      { processor: 'maximizer.truePeakLimiter', params: { ceilingDbtp: -1 }, enabled: true },
    ]);
    expect(undo()).toBe(true);
    expect(store.mixer.masteringChain).toBeUndefined();
    expect(redo()).toBe(true);
    expect(store.mixer.masteringChain?.processors).toHaveLength(1);
  });

  it('removes a processor and drops the field when the chain empties', () => {
    addMasteringProcessor('eq.tilt');
    removeMasteringProcessor(0);
    expect(store.mixer.masteringChain).toBeUndefined();
    undo();
    expect(store.mixer.masteringChain?.processors).toHaveLength(1);
  });

  it('toggles a processor enabled state as one edit', () => {
    addMasteringProcessor('saturation.tape');
    setMasteringEnabled(0, false);
    expect(store.mixer.masteringChain?.processors[0].enabled).toBe(false);
    setMasteringEnabled(0, false); // no-op: no history entry
    undo();
    expect(store.mixer.masteringChain?.processors[0].enabled).toBe(true);
  });

  it('sets and clears the preset as undoable edits', () => {
    setMasteringPreset('pop');
    expect(store.mixer.masteringChain?.preset).toBe('pop');
    setMasteringPreset(null);
    expect(store.mixer.masteringChain).toBeUndefined();
    undo();
    expect(store.mixer.masteringChain?.preset).toBe('pop');
    undo();
    expect(store.mixer.masteringChain).toBeUndefined();
  });

  it('keeps the preset alongside processors', () => {
    setMasteringPreset('jpop');
    addMasteringProcessor('eq.tilt', { tiltDb: 1 });
    expect(store.mixer.masteringChain).toMatchObject({
      preset: 'jpop',
      processors: [{ processor: 'eq.tilt', params: { tiltDb: 1 }, enabled: true }],
    });
    setMasteringPreset(null);
    expect(store.mixer.masteringChain).toMatchObject({
      processors: [{ processor: 'eq.tilt', params: { tiltDb: 1 }, enabled: true }],
    });
  });

  it('sets, clears and undoes mastering preset overrides', () => {
    setMasteringPreset('streaming');
    applyMasteringPresetWithOverrides('streaming', { loudness: { targetLufs: -14 } });
    applyMasteringPresetWithOverrides('streaming', {
      loudness: { targetLufs: -14 },
      maximizer: { truePeakLimiter: { enabled: true } },
    });
    expect(store.mixer.masteringChain).toEqual({
      preset: 'streaming',
      presetOverrides: {
        loudness: { targetLufs: -14 },
        maximizer: { truePeakLimiter: { enabled: true } },
      },
      processors: [],
    });

    undo();
    expect(store.mixer.masteringChain?.presetOverrides).toEqual({ loudness: { targetLufs: -14 } });
    undo();
    expect(store.mixer.masteringChain?.presetOverrides).toBeUndefined();
    applyMasteringPresetWithOverrides('streaming', {});
    expect(store.mixer.masteringChain?.presetOverrides).toBeUndefined();
  });

  it('clears preset overrides when clearing the preset', () => {
    applyMasteringPresetWithOverrides('pop', { loudness: { targetLufs: -14 } });
    setMasteringPreset(null);
    expect(store.mixer.masteringChain).toBeUndefined();
    undo();
    expect(store.mixer.masteringChain).toEqual({
      preset: 'pop',
      presetOverrides: { loudness: { targetLufs: -14 } },
      processors: [],
    });
  });

  it('coalesces a param drag into a single history entry', () => {
    addMasteringProcessor('dynamics.compressor', { thresholdDb: -12 });
    setMasteringParam(0, 'thresholdDb', -14, { commit: false });
    setMasteringParam(0, 'thresholdDb', -18, { commit: false });
    setMasteringParam(0, 'thresholdDb', -20);
    expect(store.mixer.masteringChain?.processors[0].params.thresholdDb).toBe(-20);
    undo(); // the whole drag
    expect(store.mixer.masteringChain?.processors[0].params.thresholdDb).toBe(-12);
    undo(); // the add
    expect(store.mixer.masteringChain).toBeUndefined();
  });

  it('is a no-op when setting an unchanged param or preset', () => {
    addMasteringProcessor('eq.tilt', { tiltDb: 2 });
    clearHistory();
    setMasteringParam(0, 'tiltDb', 2);
    setMasteringPreset(null);
    expect(undo()).toBe(false);
  });

  it('reorders a processor as a single undoable edit', () => {
    addMasteringProcessor('eq.tilt', { tiltDb: 1 });
    addMasteringProcessor('dynamics.compressor', { thresholdDb: -12 });
    addMasteringProcessor('saturation.tape');
    setMasteringEnabled(2, false);
    clearHistory();

    reorderMasteringProcessor(2, 0);
    expect(store.mixer.masteringChain?.processors).toMatchObject([
      { processor: 'saturation.tape', params: {}, enabled: false },
      { processor: 'eq.tilt', params: { tiltDb: 1 }, enabled: true },
      { processor: 'dynamics.compressor', params: { thresholdDb: -12 }, enabled: true },
    ]);
    // The whole move is one undo step, not one per add/remove primitive.
    expect(undo()).toBe(true);
    expect(store.mixer.masteringChain?.processors.map((p) => p.processor)).toEqual([
      'eq.tilt',
      'dynamics.compressor',
      'saturation.tape',
    ]);
    expect(undo()).toBe(false);
  });

  it('remaps processor automation on reorder/removal and restores it on undo', () => {
    addMasteringProcessor('eq.tilt');
    addMasteringProcessor('dynamics.compressor');
    addMasteringProcessor('saturation.tape');
    const [tiltId, compressorId, tapeId] =
      store.mixer.masteringChain?.processors.map((slot) => slot.id as string) ?? [];
    const originalParams = [
      masteringAutomationParam(tiltId, 'tiltDb'),
      masteringAutomationParam(compressorId, 'thresholdDb'),
      masteringAutomationParam(tapeId, 'drive'),
    ];
    store.automationLanes = [
      {
        target: 'master',
        param: originalParams[0],
        points: [{ ppq: 0, value: 1 }],
        enabled: true,
      },
      {
        target: 'master',
        param: originalParams[1],
        points: [{ ppq: 0, value: -18 }],
        enabled: true,
      },
      {
        target: 'master',
        param: originalParams[2],
        points: [{ ppq: 0, value: 0.5 }],
        enabled: true,
      },
    ];
    clearHistory();

    reorderMasteringProcessor(2, 0);
    expect(store.automationLanes.map((lane) => lane.param)).toEqual(originalParams);
    expect(undo()).toBe(true);
    expect(store.automationLanes.map((lane) => lane.param)).toEqual(originalParams);

    removeMasteringProcessor(1);
    expect(store.automationLanes.map((lane) => lane.param)).toEqual([
      originalParams[0],
      originalParams[2],
    ]);
    expect(undo()).toBe(true);
    expect(store.automationLanes.map((lane) => lane.param)).toEqual(originalParams);
  });

  it('keeps stable MIDI targets on reorder and prunes/restores them on removal', () => {
    addMasteringProcessor('eq.tilt');
    addMasteringProcessor('dynamics.compressor');
    const [tiltId, compressorId] =
      store.mixer.masteringChain?.processors.map((slot) => slot.id as string) ?? [];
    const tiltTarget = midiLearnMasteringTargetId(tiltId, 'tiltDb');
    const compressorTarget = midiLearnMasteringTargetId(compressorId, 'thresholdDb');
    store.midiCcBindings.set(tiltTarget, { channel: 1, controller: 30 });
    store.midiCcBindings.set(compressorTarget, { channel: 1, controller: 31 });
    clearHistory();

    reorderMasteringProcessor(1, 0);
    expect(store.midiCcBindings.get(compressorTarget)).toEqual({ channel: 1, controller: 31 });
    expect(store.midiCcBindings.get(tiltTarget)).toEqual({ channel: 1, controller: 30 });

    removeMasteringProcessor(0);
    expect(store.midiCcBindings.has(compressorTarget)).toBe(false);
    expect(store.midiCcBindings.get(tiltTarget)).toEqual({ channel: 1, controller: 30 });

    expect(undo()).toBe(true);
    expect(store.midiCcBindings.get(compressorTarget)).toEqual({ channel: 1, controller: 31 });
  });

  it('treats an in-place reorder as a no-op and validates indices', () => {
    addMasteringProcessor('eq.tilt');
    clearHistory();
    reorderMasteringProcessor(0, 0);
    expect(undo()).toBe(false);
    expect(() => reorderMasteringProcessor(0, 1)).toThrow(RangeError);
    expect(() => reorderMasteringProcessor(-1, 0)).toThrow(RangeError);
  });

  it('validates names, params and indices', () => {
    expect(() => addMasteringProcessor('' as SoloProcessor)).toThrow(RangeError);
    expect(() => addMasteringProcessor('eq.tilt', { tiltDb: Number.NaN })).toThrow(RangeError);
    expect(() => setMasteringPreset('' as MasteringPreset)).toThrow(RangeError);
    expect(() => removeMasteringProcessor(0)).toThrow(RangeError);
    expect(() => setMasteringEnabled(5, true)).toThrow(RangeError);
    addMasteringProcessor('eq.tilt');
    expect(() => setMasteringParam(0, '', 1)).toThrow(RangeError);
    expect(() => setMasteringParam(0, 'tiltDb', Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => setMasteringParam(1, 'tiltDb', 1)).toThrow(RangeError);
    expect(() =>
      applyMasteringPresetWithOverrides('pop', { loudness: { targetLufs: Number.NaN } }),
    ).toThrow(RangeError);
    expect(() =>
      applyMasteringPresetWithOverrides('pop', {
        maximizer: { truePeakLimiter: { ceilingDbtp: Number.POSITIVE_INFINITY } },
      }),
    ).toThrow(RangeError);
  });
});

describe('mastering chain serialization', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('keeps the document mixer-free while the chain is default', () => {
    expect(isDefaultMixerState(store.mixer)).toBe(true);
    expect(serializeProject().mixer).toBeUndefined();
  });

  it('round-trips the mastering chain through the document', async () => {
    applyMasteringPresetWithOverrides('streaming', { loudness: { targetLufs: -14 } });
    addMasteringProcessor('maximizer.truePeakLimiter', { ceilingDbtp: -1, oversampleFactor: 4 });
    setMasteringEnabled(0, false);
    setStripGain('master', -2);

    const doc = serializeProject();
    expect(doc.mixer?.masteringChain).toMatchObject({
      preset: 'streaming',
      presetOverrides: { loudness: { targetLufs: -14 } },
      processors: [
        {
          processor: 'maximizer.truePeakLimiter',
          params: { ceilingDbtp: -1, oversampleFactor: 4 },
          enabled: false,
        },
      ],
    });

    await loadProjectDocument(JSON.parse(JSON.stringify(doc)));
    expect(store.mixer.masteringChain).toEqual(doc.mixer?.masteringChain);
    expect(store.mixer.master.gainDb).toBe(-2);
  });

  it('marks the mixer state non-default with only a mastering chain set', () => {
    setMasteringPreset('pop');
    expect(isDefaultMixerState(store.mixer)).toBe(false);
    const doc = serializeProject();
    expect(doc.mixer?.masteringChain?.preset).toBe('pop');
    expect(doc.mixer?.master.gainDb).toBe(0);
  });
});
