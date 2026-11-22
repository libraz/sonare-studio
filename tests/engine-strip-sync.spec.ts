import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import { linearToDb } from '@/engine/mixer-sync';
import {
  busScene,
  createStripSync,
  groupBusGainDb,
  MAX_ENGINE_BUSES,
  stripScene,
} from '@/engine/strip-sync';
import {
  createDefaultMixerState,
  createDefaultStrip,
  type MixerBus,
  type MixerStrip,
  type ProjectMixerState,
} from '@/project/mixer';
import type { EditorTrack } from '@/project/types';
import { type EqBandInput, ErrorCode, SonareError } from '@/wasm/index.js';

type RuntimeModule = NonNullable<ReturnType<typeof import('@/project/runtime').currentWasmModule>>;
const runtimeState = vi.hoisted(() => ({ ready: true }));

vi.mock('@/project/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/project/runtime')>()),
  currentWasmModule: () => (runtimeState.ready ? ({} as RuntimeModule) : null),
}));

// The soft clipper's ceiling is read only when the insert is built.
vi.mock('@/project/processor-controls', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/project/processor-controls')>()),
  // Keep the strip-sync tests independent of WASM startup while still
  // exercising the catalog's root/conditional distinction.
  catalogParamInfo: (processor: string) => {
    const rootParams: Record<string, string[]> = {
      'dynamics.compressor': ['thresholdDb'],
      'gate.expander': ['floorDb'],
      'saturation.ampSim': [
        'drive',
        'bassDb',
        'midDb',
        'trebleDb',
        'presenceDb',
        'levelDb',
        'power',
        'sag',
        'transformer',
        'nfb',
        'micAxis',
        'micBAxis',
        'micBlend',
        'cone',
        'crossover',
        'biasShift',
        'inputDb',
      ],
      'saturation.softClipper': ['driveDb'],
      'saturation.tape': ['drive'],
    };
    const names = rootParams[processor];
    if (names === undefined) {
      if (processor !== 'eq.parametric') return [];
      return [
        {
          name: 'band0.gainDb',
          id: 0,
          rtSafe: true,
          type: 'number' as const,
          min: null,
          max: null,
          default: null,
          unit: null,
          choices: null,
          slot: 'band0',
        },
      ];
    }
    return names.map((name, id) => ({
      name,
      id,
      rtSafe: true,
      type: 'number' as const,
      min: null,
      max: null,
      default: null,
      unit: null,
      choices: null,
      slot: null,
    }));
  },
  isConstructionOnlyParam: (processor: string, param: string) =>
    processor === 'saturation.softClipper' && param === 'ceiling',
}));

afterEach(() => {
  runtimeState.ready = true;
});

/** Builds a track mirror entry, optionally with a mixer strip. */
function makeTrack(id: number, mixer?: MixerStrip): EditorTrack {
  return {
    id,
    name: `Track ${id}`,
    color: '#60a5fa',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: id,
    ...(mixer ? { mixer } : {}),
  };
}

/** Builds a group track mirror entry, optionally with a mixer strip. */
function makeGroupTrack(id: number, mixer?: MixerStrip): EditorTrack {
  return { ...makeTrack(id, mixer), kind: 'group' };
}

/** Builds a strip with overridable fields. */
function makeStrip(overrides: Partial<MixerStrip> = {}): MixerStrip {
  return { ...createDefaultStrip(), ...overrides };
}

/** Builds a project mixer state with overridable fields. */
function makeMixer(overrides: Partial<ProjectMixerState> = {}): ProjectMixerState {
  return { ...createDefaultMixerState(), ...overrides };
}

/** Builds a bus entry with a neutral gain by default. */
function makeBus(id: string, gainDb = 0): MixerBus {
  return { id, name: id, gainDb };
}

/** EngineHandle stub capturing the strip/bus/send commands. */
function makeHandle(): {
  handle: EngineHandle;
  engine: {
    setStrip: ReturnType<typeof vi.fn>;
    setBusStrip: ReturnType<typeof vi.fn>;
    setStripInsertParam: ReturnType<typeof vi.fn>;
    setBusInsertParam: ReturnType<typeof vi.fn>;
    setStripEqBand: ReturnType<typeof vi.fn>;
    setBusEqBand: ReturnType<typeof vi.fn>;
    setStripInsertBypassed: ReturnType<typeof vi.fn>;
    setBusInsertBypassed: ReturnType<typeof vi.fn>;
    setTrackBuses: ReturnType<typeof vi.fn>;
    setBusGainDb: ReturnType<typeof vi.fn>;
    setTrackSends: ReturnType<typeof vi.fn>;
    setTrackOutputBus: ReturnType<typeof vi.fn>;
    setStripSidechain: ReturnType<typeof vi.fn>;
    setBusSidechain: ReturnType<typeof vi.fn>;
    setBusPan: ReturnType<typeof vi.fn>;
    setBusPanLaw: ReturnType<typeof vi.fn>;
    setBusPanMode: ReturnType<typeof vi.fn>;
    setBusDualPan: ReturnType<typeof vi.fn>;
  };
} {
  const engine = {
    setStrip: vi.fn(),
    setBusStrip: vi.fn(),
    setStripInsertParam: vi.fn(),
    setBusInsertParam: vi.fn(),
    setStripEqBand: vi.fn(),
    setBusEqBand: vi.fn(),
    setStripInsertBypassed: vi.fn(),
    setBusInsertBypassed: vi.fn(),
    setTrackBuses: vi.fn(),
    setBusGainDb: vi.fn(),
    setTrackSends: vi.fn(),
    setTrackOutputBus: vi.fn(),
    setStripSidechain: vi.fn(),
    setBusSidechain: vi.fn(),
    setBusPan: vi.fn(),
    setBusPanLaw: vi.fn(),
    setBusPanMode: vi.fn(),
    setBusDualPan: vi.fn(),
  };
  const handle = { engine, ctx: { state: 'running' } } as unknown as EngineHandle;
  return { handle, engine };
}

/** Strips sent to the master target, in call order. */
function masterScenes(engine: ReturnType<typeof makeHandle>['engine']): unknown[] {
  return engine.setStrip.mock.calls
    .filter(([target]) => target === 'master')
    .map(([, scene]) => scene);
}

/** Strips sent to a track target, in call order. */
function trackScenes(engine: ReturnType<typeof makeHandle>['engine']): unknown[] {
  return engine.setStrip.mock.calls
    .filter(([target]) => target !== 'master')
    .map(([, scene]) => scene);
}

/** Total number of engine calls captured across all stubbed methods. */
function totalCalls(engine: ReturnType<typeof makeHandle>['engine']): number {
  return Object.values(engine).reduce((sum, fn) => sum + fn.mock.calls.length, 0);
}

/** Clears all captured engine calls. */
function clearCalls(engine: ReturnType<typeof makeHandle>['engine']): void {
  for (const fn of Object.values(engine)) fn.mockClear();
}

describe('stripScene', () => {
  it('declares all inserts (enabled and disabled) with their params embedded', () => {
    const strip = makeStrip({
      inserts: [
        { processor: 'dynamics.compressor', params: { thresholdDb: -20 }, enabled: true },
        { processor: 'saturation.tape', params: { drive: 0.4 }, enabled: false },
      ],
    });
    expect(stripScene(7, strip)).toEqual({
      id: 'track-7',
      inserts: [
        { slot: 'pre', processor: 'dynamics.compressor', params: { thresholdDb: -20 } },
        { slot: 'pre', processor: 'saturation.tape', params: { drive: 0.4 } },
      ],
    });
  });

  it('declares strip-local trim width and polarity fields', () => {
    const strip = makeStrip({
      inputTrimDb: 3,
      width: 0.5,
      polarityInvertRight: true,
    });
    expect(stripScene(7, strip)).toEqual({
      id: 'track-7',
      inserts: [],
      inputTrimDb: 3,
      width: 0.5,
      polarityInvertRight: true,
    });
  });

  it('declares source layout and the surround pan the engine carries', () => {
    const scene = stripScene(
      7,
      makeStrip({
        sourceLayout: '5.1',
        surroundPan: {
          azimuth: 45,
          elevation: 2,
          divergence: 0.25,
          lfe: 0.1,
          distance: 0.8,
        },
      }),
    );
    expect(scene).toMatchObject({
      sourceLayout: '5.1',
      surroundPan: { azimuth: 45, divergence: 0.25, lfe: 0.1 },
    });
    expect(scene.surroundPan).not.toHaveProperty('elevation');
    expect(scene.surroundPan).not.toHaveProperty('distance');
  });

  it('uses the master strip id for the master target', () => {
    expect(stripScene('master', makeStrip()).id).toBe('master');
  });

  it('declares an empty strip for a missing strip', () => {
    expect(stripScene(3, undefined)).toEqual({ id: 'track-3', inserts: [] });
  });

  it('rejects a processor not in the insert catalog', () => {
    const strip = makeStrip({
      inserts: [{ processor: 'saturation.tape', params: {}, enabled: true }],
    });
    expect(() => stripScene(1, strip, new Set(['dynamics.compressor']))).toThrow(
      'Unsupported insert processor: saturation.tape',
    );
  });

  it('skips validation when the catalog is null', () => {
    const strip = makeStrip({
      inserts: [{ processor: 'made.up', params: {}, enabled: true }],
    });
    expect(() => stripScene(1, strip, null)).not.toThrow();
  });
});

describe('createStripSync', () => {
  it('sends the strip JSON once, bypasses disabled inserts, and dedupes', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const track = makeTrack(
      1,
      makeStrip({
        inserts: [
          { processor: 'dynamics.compressor', params: { thresholdDb: -20 }, enabled: true },
          { processor: 'saturation.tape', params: { drive: 0.4 }, enabled: false },
        ],
      }),
    );

    sync.sync([track], makeMixer());
    expect(engine.setStrip).toHaveBeenCalledTimes(1);
    expect(engine.setStrip).toHaveBeenCalledWith(1, stripScene(1, track.mixer));
    expect(engine.setStripInsertBypassed).toHaveBeenCalledTimes(2);
    expect(engine.setStripInsertBypassed).toHaveBeenCalledWith(1, 0, { bypassed: false });
    expect(engine.setStripInsertBypassed).toHaveBeenCalledWith(1, 1, { bypassed: true });

    clearCalls(engine);
    sync.sync([track], makeMixer());
    expect(totalCalls(engine)).toBe(0);
  });

  it('resends strip JSON when strip-local DSP fields change', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const track = makeTrack(1, makeStrip({ inputTrimDb: 3 }));
    const mixer = makeMixer();

    sync.sync([track], mixer);
    clearCalls(engine);

    sync.sync([{ ...track, mixer: makeStrip({ inputTrimDb: 6 }) }], mixer);

    expect(engine.setStrip).toHaveBeenCalledWith(1, stripScene(1, makeStrip({ inputTrimDb: 6 })));
  });

  it('sends source layout and surround pan metadata on metadata-only changes', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const first = makeStrip({
      sourceLayout: '5.1',
      surroundPan: {
        azimuth: 30,
        elevation: 0,
        divergence: 0,
        lfe: 0,
        distance: 1,
      },
    });

    sync.sync([makeTrack(1, first)], makeMixer());
    expect(engine.setStrip).toHaveBeenCalledWith(1, stripScene(1, first));
    clearCalls(engine);

    const next = makeStrip({
      sourceLayout: '7.1',
      surroundPan: {
        azimuth: -45,
        elevation: 1,
        divergence: 0.25,
        lfe: 0.1,
        distance: 0.8,
      },
    });
    sync.sync([makeTrack(1, next)], makeMixer());
    expect(engine.setStrip).toHaveBeenCalledTimes(1);
    expect(engine.setStrip).toHaveBeenCalledWith(1, stripScene(1, next));
  });

  it('toggles only the bypass flag when an insert is enabled/disabled', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const inserts = [
      { processor: 'dynamics.compressor', params: { thresholdDb: -20 }, enabled: true },
      { processor: 'saturation.tape', params: { drive: 0.4 }, enabled: false },
    ];
    sync.sync([makeTrack(1, makeStrip({ inserts }))], makeMixer());
    clearCalls(engine);

    const toggled = inserts.map((slot, i) => (i === 1 ? { ...slot, enabled: true } : slot));
    sync.sync([makeTrack(1, makeStrip({ inserts: toggled }))], makeMixer());
    expect(engine.setStrip).not.toHaveBeenCalled();
    expect(engine.setStripInsertBypassed).toHaveBeenCalledTimes(1);
    expect(engine.setStripInsertBypassed).toHaveBeenCalledWith(1, 1, { bypassed: false });
  });

  it.each([1, 'master'] as const)(
    'clears %s insert bypass on a structural strip resend',
    (target) => {
      const { handle, engine } = makeHandle();
      const sync = createStripSync(handle);
      const first = makeStrip({
        inserts: [{ processor: 'saturation.tape', params: { drive: 0.4 }, enabled: false }],
      });
      const second = makeStrip({
        ...first,
        width: 0.8,
        inserts: [{ ...first.inserts[0], enabled: true }],
      });
      const send = (strip: MixerStrip) =>
        target === 'master'
          ? sync.sync([], makeMixer({ master: strip }))
          : sync.sync([makeTrack(target, strip)], makeMixer());

      send(first);
      clearCalls(engine);
      send(second);

      expect(engine.setStripInsertBypassed).toHaveBeenCalledWith(target, 0, { bypassed: false });
    },
  );

  it('patches numeric insert param changes without re-sending strip JSON', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const band: EqBandInput = { frequencyHz: 200, gainDb: 3, enabled: true };
    const stripFor = (thresholdDb: number): MixerStrip =>
      makeStrip({
        inserts: [
          { processor: 'dynamics.compressor', params: { thresholdDb }, enabled: true },
          { processor: 'saturation.tape', params: { drive: 0.4 }, enabled: false },
        ],
        eq: { enabled: true, bands: [band] },
      });

    sync.sync([makeTrack(1, stripFor(-20))], makeMixer());
    clearCalls(engine);

    const next = stripFor(-12);
    sync.sync([makeTrack(1, next)], makeMixer());
    expect(engine.setStrip).not.toHaveBeenCalled();
    expect(engine.setStripInsertParam).toHaveBeenCalledTimes(1);
    expect(engine.setStripInsertParam).toHaveBeenCalledWith(1, 0, {
      name: 'thresholdDb',
      value: -12,
    });
    expect(engine.setStripInsertBypassed).not.toHaveBeenCalled();
    expect(engine.setStripEqBand).not.toHaveBeenCalled();
  });

  it('rebuilds the insert when a construction-only numeric param changes', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const stripFor = (ceiling: number, driveDb: number): MixerStrip =>
      makeStrip({
        inserts: [
          { processor: 'saturation.softClipper', params: { ceiling, driveDb }, enabled: true },
        ],
      });

    sync.sync([makeTrack(1, stripFor(0.9, 3))], makeMixer());
    clearCalls(engine);

    sync.sync([makeTrack(1, stripFor(0.9, 6))], makeMixer());
    expect(engine.setStrip).not.toHaveBeenCalled();
    expect(engine.setStripInsertParam).toHaveBeenCalledWith(1, 0, { name: 'driveDb', value: 6 });
    clearCalls(engine);

    const next = stripFor(0.7, 6);
    sync.sync([makeTrack(1, next)], makeMixer());
    expect(engine.setStrip).toHaveBeenCalledWith(1, stripScene(1, next));
    expect(engine.setStripInsertParam).not.toHaveBeenCalled();
  });

  it('rebuilds the guitar amp when its preset changes', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const stripFor = (presetIndex: number): MixerStrip =>
      makeStrip({
        inserts: [
          {
            processor: 'saturation.ampSim',
            params: { presetIndex, drive: 0.55 },
            enabled: true,
          },
        ],
      });

    sync.sync([makeTrack(1, stripFor(0))], makeMixer());
    clearCalls(engine);
    const next = stripFor(5);
    sync.sync([makeTrack(1, next)], makeMixer());

    expect(engine.setStrip).toHaveBeenCalledWith(1, stripScene(1, next));
    expect(engine.setStripInsertParam).not.toHaveBeenCalled();
  });

  it('patches the first root amp override without rebuilding the strip', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const stripFor = (params: Record<string, number>): MixerStrip =>
      makeStrip({
        inserts: [{ processor: 'saturation.ampSim', params, enabled: true }],
      });

    sync.sync([makeTrack(1, stripFor({ presetIndex: 0 }))], makeMixer());
    clearCalls(engine);

    sync.sync([makeTrack(1, stripFor({ presetIndex: 0, bassDb: 6 }))], makeMixer());

    expect(engine.setStrip).not.toHaveBeenCalled();
    expect(engine.setStripInsertParam).toHaveBeenCalledWith(1, 0, { name: 'bassDb', value: 6 });
  });

  it.each([1, 'master'] as const)(
    'rebuilds %s when a root realtime insert value is removed',
    (target) => {
      const { handle, engine } = makeHandle();
      const sync = createStripSync(handle);
      const withBass = makeStrip({
        inserts: [
          {
            processor: 'saturation.ampSim',
            params: { presetIndex: 0, bassDb: 6 },
            enabled: true,
          },
        ],
      });
      const withoutBass = makeStrip({
        inserts: [{ processor: 'saturation.ampSim', params: { presetIndex: 0 }, enabled: true }],
      });
      const send = (strip: MixerStrip): void => {
        if (target === 'master') {
          sync.sync([], makeMixer({ master: strip }));
        } else {
          sync.sync([makeTrack(target, strip)], makeMixer());
        }
      };

      send(withBass);
      clearCalls(engine);
      send(withoutBass);

      if (target === 'master') {
        expect(engine.setStrip).toHaveBeenCalledWith('master', stripScene('master', withoutBass));
      } else {
        expect(engine.setStrip).toHaveBeenCalledWith(1, stripScene(1, withoutBass));
      }
      expect(engine.setStripInsertParam).not.toHaveBeenCalled();
      expect(engine.setStripInsertParam).not.toHaveBeenCalled();
    },
  );

  it('patches and safely rebuilds a root amp override on a return bus', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const busFor = (params: Record<string, number>): MixerBus => ({
      ...makeBus('FX'),
      strip: makeStrip({
        inserts: [{ processor: 'saturation.ampSim', params, enabled: true }],
      }),
    });

    sync.sync([], makeMixer({ buses: [busFor({ presetIndex: 0 })] }));
    clearCalls(engine);
    sync.sync([], makeMixer({ buses: [busFor({ presetIndex: 0, bassDb: 6 })] }));
    expect(engine.setBusStrip).not.toHaveBeenCalled();
    expect(engine.setBusInsertParam).toHaveBeenCalledWith(1, 0, { name: 'bassDb', value: 6 });

    clearCalls(engine);
    const withoutBass = busFor({ presetIndex: 0 });
    sync.sync([], makeMixer({ buses: [withoutBass] }));
    expect(engine.setBusStrip).toHaveBeenCalledWith(1, busScene(1, withoutBass.strip));
    expect(engine.setBusInsertParam).not.toHaveBeenCalled();
  });

  it('rebuilds when a conditional insert slot first appears or disappears', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const stripFor = (params: Record<string, number>): MixerStrip =>
      makeStrip({ inserts: [{ processor: 'eq.parametric', params, enabled: true }] });

    sync.sync([makeTrack(1, stripFor({}))], makeMixer());
    clearCalls(engine);
    const firstBand = stripFor({ 'band0.gainDb': 3 });
    sync.sync([makeTrack(1, firstBand)], makeMixer());
    expect(engine.setStrip).toHaveBeenCalledWith(1, stripScene(1, firstBand));
    expect(engine.setStripInsertParam).not.toHaveBeenCalled();

    clearCalls(engine);
    const editedBand = stripFor({ 'band0.gainDb': 5 });
    sync.sync([makeTrack(1, editedBand)], makeMixer());
    expect(engine.setStrip).not.toHaveBeenCalled();
    expect(engine.setStripInsertParam).toHaveBeenCalledWith(1, 0, {
      name: 'band0.gainDb',
      value: 5,
    });

    clearCalls(engine);
    const empty = stripFor({});
    sync.sync([makeTrack(1, empty)], makeMixer());
    expect(engine.setStrip).toHaveBeenCalledWith(1, stripScene(1, empty));
    expect(engine.setStripInsertParam).not.toHaveBeenCalled();
  });

  it('rebuilds for an unknown numeric key on a catalogued processor', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const stripFor = (mystery: number): MixerStrip =>
      makeStrip({
        inserts: [
          {
            processor: 'saturation.tape',
            params: { drive: 0.4, mystery },
            enabled: true,
          },
        ],
      });

    sync.sync([makeTrack(1, stripFor(0.1))], makeMixer());
    clearCalls(engine);
    const next = stripFor(0.2);
    sync.sync([makeTrack(1, next)], makeMixer());

    expect(engine.setStrip).toHaveBeenCalledWith(1, stripScene(1, next));
    expect(engine.setStripInsertParam).not.toHaveBeenCalled();
  });

  it('keeps the legacy numeric fallback before the WASM catalog is ready', () => {
    runtimeState.ready = false;
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const stripFor = (value: number): MixerStrip =>
      makeStrip({
        inserts: [{ processor: 'made.up', params: { value }, enabled: true }],
      });

    sync.sync([makeTrack(1, stripFor(0.1))], makeMixer());
    clearCalls(engine);
    const next = stripFor(0.2);
    sync.sync([makeTrack(1, next)], makeMixer());

    expect(engine.setStrip).not.toHaveBeenCalled();
    expect(engine.setStripInsertParam).toHaveBeenCalledWith(1, 0, { name: 'value', value: 0.2 });
  });

  it('declares a neutral track strip when another insert needs PDC on it', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const dry = makeTrack(2);
    sync.sync([dry], makeMixer(), 1, new Set([2]));
    expect(engine.setStrip).toHaveBeenCalledWith(2, stripScene(2, undefined));
  });

  it('re-sends strip JSON when a non-numeric insert param changes', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const stripFor = (mode: boolean): MixerStrip =>
      makeStrip({
        inserts: [{ processor: 'dynamics.compressor', params: { mode }, enabled: true }],
      });

    sync.sync([makeTrack(1, stripFor(false))], makeMixer());
    clearCalls(engine);

    const next = stripFor(true);
    sync.sync([makeTrack(1, next)], makeMixer());
    expect(engine.setStrip).toHaveBeenCalledTimes(1);
    expect(engine.setStrip).toHaveBeenCalledWith(1, stripScene(1, next));
    expect(engine.setStripInsertParam).not.toHaveBeenCalled();
  });

  it('sends the strip JSON and every EQ band, then diffs band edits', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const bands: EqBandInput[] = [
      {
        frequencyHz: 120,
        gainDb: -2,
        enabled: true,
        placement: 'Mid',
        phase: 'LinearPhase',
        dynamic: true,
        thresholdDb: -24,
        ratio: 2,
        rangeDb: -6,
        attackMs: 10,
        releaseMs: 120,
      },
      { frequencyHz: 4000, gainDb: 4, enabled: true },
    ];

    sync.sync([makeTrack(1, makeStrip({ eq: { enabled: true, bands } }))], makeMixer());
    expect(engine.setStrip).toHaveBeenCalledTimes(1);
    expect(engine.setStripEqBand).toHaveBeenCalledTimes(2);
    expect(engine.setStripEqBand).toHaveBeenNthCalledWith(1, 1, 0, bands[0]);
    expect(engine.setStripEqBand).toHaveBeenNthCalledWith(2, 1, 1, bands[1]);
    clearCalls(engine);

    const edited: EqBandInput[] = [bands[0], { ...bands[1], gainDb: 6 }];
    sync.sync([makeTrack(1, makeStrip({ eq: { enabled: true, bands: edited } }))], makeMixer());
    expect(engine.setStrip).not.toHaveBeenCalled();
    expect(engine.setStripEqBand).toHaveBeenCalledTimes(1);
    expect(engine.setStripEqBand).toHaveBeenCalledWith(1, 1, edited[1]);
  });

  it('clears removed EQ bands with disabled bands instead of re-sending the strip', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const bands: EqBandInput[] = [
      { frequencyHz: 120, gainDb: -2, enabled: true },
      { frequencyHz: 4000, gainDb: 4, enabled: true },
    ];
    sync.sync([makeTrack(1, makeStrip({ eq: { enabled: true, bands } }))], makeMixer());
    clearCalls(engine);

    sync.sync([makeTrack(1, makeStrip())], makeMixer());
    expect(engine.setStrip).not.toHaveBeenCalled();
    expect(engine.setStripEqBand).toHaveBeenCalledTimes(2);
    expect(engine.setStripEqBand).toHaveBeenNthCalledWith(1, 1, 0, { enabled: false });
    expect(engine.setStripEqBand).toHaveBeenNthCalledWith(2, 1, 1, { enabled: false });
    clearCalls(engine);

    // The cleared bands stay cleared without further calls.
    sync.sync([makeTrack(1, makeStrip())], makeMixer());
    expect(totalCalls(engine)).toBe(0);
  });

  it('treats a disabled EQ as having no bands', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const eq = { enabled: false, bands: [{ frequencyHz: 200, gainDb: 3, enabled: true }] };

    sync.sync([makeTrack(1, makeStrip({ eq }))], makeMixer());
    expect(totalCalls(engine)).toBe(0);
  });

  it('routes the master strip through setStrip and the master target', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const band: EqBandInput = { frequencyHz: 8000, gainDb: -1, enabled: true };
    const master = makeStrip({
      inserts: [{ processor: 'saturation.tape', params: { drive: 0.2 }, enabled: false }],
      eq: { enabled: true, bands: [band] },
    });

    sync.sync([], makeMixer({ master }));
    expect(trackScenes(engine)).toHaveLength(0);
    expect(masterScenes(engine)).toHaveLength(1);
    expect(engine.setStrip).toHaveBeenCalledWith('master', stripScene('master', master));
    expect(engine.setStripInsertBypassed).toHaveBeenCalledWith('master', 0, { bypassed: true });
    expect(engine.setStripEqBand).toHaveBeenCalledWith('master', 0, band);
  });

  it('declares master panner detail fields and re-sends when they change', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const master = makeStrip({
      panLaw: 'const6Db',
      panMode: 'dualPan',
      dualPan: { left: -0.6, right: 0.7 },
    });

    sync.sync([], makeMixer({ master }));
    expect(masterScenes(engine)[0]).toMatchObject({
      panLaw: 'const6Db',
      panMode: 'dualPan',
      dualPanLeft: -0.6,
      dualPanRight: 0.7,
    });
    clearCalls(engine);

    sync.sync(
      [],
      makeMixer({ master: makeStrip({ ...master, dualPan: { left: -0.4, right: 0.7 } }) }),
    );
    expect(masterScenes(engine)).toHaveLength(1);
  });

  it('keeps master gain and pan when a strip scene replacement resets engine scalars', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const live = { gainDb: -6, pan: 0.4 };
    engine.setStrip.mockImplementation(
      (target: number | 'master', scene: { faderDb?: number; pan?: number }) => {
        if (target !== 'master') return;
        live.gainDb = scene.faderDb ?? 0;
        live.pan = scene.pan ?? 0;
      },
    );
    const master = makeStrip({
      gainDb: -6,
      pan: 0.4,
      inserts: [{ processor: 'saturation.tape', params: { drive: 0.4 }, enabled: true }],
    });

    sync.sync([], makeMixer({ master }));
    expect(live).toEqual({ gainDb: -6, pan: 0.4 });
    sync.sync([], makeMixer({ master: makeStrip({ ...master, width: 0.8 }) }));
    expect(live).toEqual({ gainDb: -6, pan: 0.4 });
  });

  it('replays master DSP state after a lane-scene declaration replaces its retained scene', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const band: EqBandInput = { frequencyHz: 8000, gainDb: -1, enabled: true };
    const master = makeStrip({
      inserts: [{ processor: 'saturation.tape', params: { drive: 0.2 }, enabled: false }],
      eq: { enabled: true, bands: [band] },
    });
    let masterScene: { inserts: Array<{ params: unknown }> } | undefined;
    const masterEq = new Map<number, EqBandInput>();
    const masterBypassed = new Map<number, boolean>();
    engine.setStrip.mockImplementation(
      (target: number | 'master', scene: { inserts: Array<{ params: unknown }> }) => {
        if (target !== 'master') return;
        // The realtime facade retains and replays the scene when lanes are
        // redeclared, but that scene does not carry the EQ/bypass side channels.
        masterScene = scene;
        masterEq.clear();
        masterBypassed.clear();
      },
    );
    engine.setStripEqBand.mockImplementation(
      (target: number | 'master', index: number, next: EqBandInput) => {
        if (target === 'master') masterEq.set(index, next);
      },
    );
    engine.setStripInsertBypassed.mockImplementation(
      (target: number | 'master', index: number, state: { bypassed: boolean }) => {
        if (target === 'master') masterBypassed.set(index, state.bypassed);
      },
    );

    sync.sync([makeTrack(1)], makeMixer({ master }), 1);
    expect(masterEq.get(0)).toEqual(band);
    expect(masterBypassed.get(0)).toBe(true);
    expect(masterScene?.inserts[0].params).toEqual({ drive: 0.2 });

    // Simulate a new lane declaration in the facade. It replaces the master
    // strip from its retained scene, so the dedicated side-channel state is
    // now empty until StripSync sees the next scene generation.
    engine.setStrip('master', masterScene);
    expect(masterEq).toEqual(new Map());
    expect(masterBypassed).toEqual(new Map());
    clearCalls(engine);

    sync.sync([makeTrack(1), makeTrack(2)], makeMixer({ master }), 2);

    expect(engine.setStrip).toHaveBeenCalledWith('master', stripScene('master', master));
    expect(engine.setStripEqBand).toHaveBeenCalledWith('master', 0, band);
    expect(engine.setStripInsertBypassed).toHaveBeenCalledWith('master', 0, { bypassed: true });
    expect(masterEq.get(0)).toEqual(band);
    expect(masterBypassed.get(0)).toBe(true);
    expect(masterScene?.inserts[0].params).toEqual({ drive: 0.2 });
  });

  it('patches master insert numeric params without replacing the master strip', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const masterFor = (drive: number): MixerStrip =>
      makeStrip({
        inserts: [{ processor: 'saturation.tape', params: { drive }, enabled: true }],
      });

    sync.sync([], makeMixer({ master: masterFor(0.2) }));
    clearCalls(engine);

    sync.sync([], makeMixer({ master: masterFor(0.6) }));
    expect(masterScenes(engine)).toHaveLength(0);
    expect(engine.setStripInsertParam).toHaveBeenCalledTimes(1);
    expect(engine.setStripInsertParam).toHaveBeenCalledWith('master', 0, {
      name: 'drive',
      value: 0.6,
    });
  });

  it('appends realtime-safe mastering processors to the live master strip', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle, {
      insertCatalog: new Set(['dynamics.compressor', 'stereo.imager']),
    });
    const master = makeStrip({
      inserts: [{ processor: 'dynamics.compressor', params: { thresholdDb: -18 }, enabled: true }],
    });

    sync.sync(
      [],
      makeMixer({
        master,
        masteringChain: {
          preset: 'club',
          processors: [
            { processor: 'repair.declick', params: {}, enabled: true },
            { processor: 'stereo.imager', params: { width: 1.2 }, enabled: true },
            { processor: 'dynamics.compressor', params: { thresholdDb: -24 }, enabled: false },
          ],
        },
      }),
    );

    expect(masterScenes(engine)).toHaveLength(1);
    expect(masterScenes(engine)[0]).toEqual({
      id: 'master',
      inserts: [
        {
          slot: 'pre',
          processor: 'dynamics.compressor',
          params: { thresholdDb: -18 },
        },
        { slot: 'pre', processor: 'stereo.imager', params: { width: 1.2 } },
      ],
    });
  });

  it('declares buses before sends, then adjusts gains and re-declares additions', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const track = makeTrack(1, makeStrip({ sends: [{ busId: 'A', levelDb: -12, enabled: true }] }));

    sync.sync([track], makeMixer({ buses: [makeBus('A')] }));
    expect(engine.setTrackBuses).toHaveBeenCalledTimes(1);
    expect(engine.setTrackBuses).toHaveBeenCalledWith([{ busId: 1, gainDb: 0 }]);
    expect(engine.setTrackSends).toHaveBeenCalledTimes(1);
    expect(engine.setTrackSends).toHaveBeenCalledWith(1, [
      { busId: 1, levelDb: -12, enabled: true },
    ]);
    expect(engine.setTrackBuses.mock.invocationCallOrder[0]).toBeLessThan(
      engine.setTrackSends.mock.invocationCallOrder[0],
    );
    clearCalls(engine);

    // A gain change on an unchanged bus set adjusts in place.
    sync.sync([track], makeMixer({ buses: [makeBus('A', -3)] }));
    expect(engine.setTrackBuses).not.toHaveBeenCalled();
    expect(engine.setBusGainDb).toHaveBeenCalledTimes(1);
    expect(engine.setBusGainDb).toHaveBeenCalledWith(1, -3);
    clearCalls(engine);

    // Adding a bus re-declares the whole set.
    sync.sync([track], makeMixer({ buses: [makeBus('A', -3), makeBus('B')] }));
    expect(engine.setTrackBuses).toHaveBeenCalledTimes(1);
    expect(engine.setTrackBuses).toHaveBeenCalledWith([
      { busId: 1, gainDb: -3 },
      { busId: 2, gainDb: 0 },
    ]);
    expect(engine.setBusGainDb).not.toHaveBeenCalled();
  });

  it('declares bus layouts, outputs, and sends as topology and patches gain alone', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const first = makeBus('A', -1);
    first.channelLayout = '5.1';
    first.strip = makeStrip({
      outputBusId: 'B',
      sends: [{ busId: 'B', levelDb: -9, enabled: true, timing: 'preFader' }],
    });
    const second = makeBus('B');

    sync.sync([], makeMixer({ buses: [first, second] }));
    expect(engine.setTrackBuses).toHaveBeenCalledWith([
      {
        busId: 1,
        gainDb: -1,
        channelLayout: '5.1',
        outputBusId: 2,
        sends: [{ busId: 2, levelDb: -9, enabled: true, sendTiming: 'preFader' }],
      },
      { busId: 2, gainDb: 0 },
    ]);
    clearCalls(engine);

    sync.sync([], makeMixer({ buses: [{ ...first, gainDb: -3 }, second] }));
    expect(engine.setTrackBuses).not.toHaveBeenCalled();
    expect(engine.setBusGainDb).toHaveBeenCalledWith(1, -3);
    clearCalls(engine);

    const changed = {
      ...first,
      strip: makeStrip({
        sends: [{ busId: 'B', levelDb: -9, enabled: true, timing: 'preFader' }],
      }),
    };
    sync.sync([], makeMixer({ buses: [changed, second] }));
    expect(engine.setTrackBuses).toHaveBeenCalledWith([
      {
        busId: 1,
        gainDb: -1,
        channelLayout: '5.1',
        sends: [{ busId: 2, levelDb: -9, enabled: true, sendTiming: 'preFader' }],
      },
      { busId: 2, gainDb: 0 },
    ]);
    expect(engine.setBusGainDb).not.toHaveBeenCalled();
  });

  it('routes group-bus outputs and sends through the compact engine map', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const group = makeGroupTrack(
      10,
      makeStrip({ sends: [{ busId: 'A', levelDb: -6, enabled: true }], outputBusId: 'A' }),
    );

    sync.sync([group], makeMixer({ buses: [makeBus('A')] }));
    expect(engine.setTrackBuses).toHaveBeenCalledWith([
      { busId: 1, gainDb: 0 },
      {
        busId: 2,
        gainDb: 0,
        outputBusId: 1,
        sends: [{ busId: 1, levelDb: -6, enabled: true }],
      },
    ]);
  });

  it('drops stale bus sends before replacing a removed destination bus', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const source = {
      ...makeBus('A'),
      strip: makeStrip({ sends: [{ busId: 'B', levelDb: -6, enabled: true }] }),
    };
    sync.sync([], makeMixer({ buses: [source, makeBus('B')] }));
    clearCalls(engine);

    sync.sync([], makeMixer({ buses: [source] }));
    expect(engine.setTrackBuses).toHaveBeenCalledWith([{ busId: 1, gainDb: 0 }]);
  });

  it('clears compacted bus sidechains before a bus-number remap', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const keyed = makeStrip({
      inserts: [
        {
          processor: 'dynamics.compressor',
          params: {},
          enabled: true,
          sidechainSourceBusId: 'B',
        },
      ],
    });
    sync.sync([], makeMixer({ buses: [{ ...makeBus('A'), strip: keyed }, makeBus('B')] }));
    clearCalls(engine);

    sync.sync([], makeMixer({ buses: [makeBus('B')] }));
    expect(engine.setBusSidechain).toHaveBeenCalledWith(1, 0, null);
    expect(engine.setBusSidechain.mock.invocationCallOrder[0]).toBeLessThan(
      engine.setTrackBuses.mock.invocationCallOrder[0],
    );
  });

  it('silences a muted return bus while retaining its stored fader value', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const bus = { ...makeBus('A', -3), mute: true };

    sync.sync([makeTrack(1)], makeMixer({ buses: [bus] }));

    expect(engine.setTrackBuses).toHaveBeenCalledWith([{ busId: 1, gainDb: -120 }]);
  });

  it('auditions a soloed return by parking direct outputs on a silent bus', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const track = makeTrack(1, makeStrip({ sends: [{ busId: 'A', levelDb: -6, enabled: true }] }));
    const group = makeGroupTrack(2);
    const member = { ...makeTrack(3), groupId: 2 };

    sync.sync(
      [track, group, member],
      makeMixer({ buses: [{ ...makeBus('A', -3), solo: true }, makeBus('B')] }),
    );

    // Buses 1-2 are the returns, 3 is the group submix and 4 the discard bus.
    expect(engine.setTrackBuses).toHaveBeenCalledWith([
      { busId: 1, gainDb: -3 },
      { busId: 2, gainDb: -120 },
      { busId: 3, gainDb: -120 },
      { busId: 4, gainDb: -120 },
    ]);
    // Direct outputs go to the discard bus; the send into the soloed return
    // is a separate tap and stays.
    expect(engine.setTrackOutputBus).toHaveBeenCalledWith(1, 4);
    expect(engine.setTrackOutputBus).toHaveBeenCalledWith(3, 4);
    expect(engine.setTrackSends).toHaveBeenCalledWith(1, [
      { busId: 1, levelDb: -6, enabled: true },
    ]);
  });

  it('restores normal routing when the return solo is released', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const track = makeTrack(1);

    sync.sync([track], makeMixer({ buses: [{ ...makeBus('A', -3), solo: true }] }));
    clearCalls(engine);

    sync.sync([track], makeMixer({ buses: [makeBus('A', -3)] }));

    expect(engine.setTrackBuses).toHaveBeenCalledWith([{ busId: 1, gainDb: -3 }]);
    expect(engine.setTrackOutputBus).toHaveBeenCalledWith(1, null);
  });

  it('marks a pre-fader send explicitly and leaves post-fader sends bare', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const track = makeTrack(
      1,
      makeStrip({
        sends: [
          { busId: 'A', levelDb: -6, enabled: true, timing: 'preFader' },
          { busId: 'B', levelDb: -12, enabled: true, timing: 'postFader' },
        ],
      }),
    );

    sync.sync([track], makeMixer({ buses: [makeBus('A'), makeBus('B')] }));
    // Pre-fader carries sendTiming; post-fader (the engine default) stays absent.
    expect(engine.setTrackSends).toHaveBeenCalledWith(1, [
      { busId: 1, levelDb: -6, enabled: true, sendTiming: 'preFader' },
      { busId: 2, levelDb: -12, enabled: true },
    ]);
    clearCalls(engine);

    // Flipping the timing re-sends the track.
    const flipped = makeTrack(
      1,
      makeStrip({ sends: [{ busId: 'A', levelDb: -6, enabled: true }] }),
    );
    sync.sync([flipped], makeMixer({ buses: [makeBus('A'), makeBus('B')] }));
    expect(engine.setTrackSends).toHaveBeenCalledTimes(1);
    expect(engine.setTrackSends).toHaveBeenCalledWith(1, [
      { busId: 1, levelDb: -6, enabled: true },
    ]);
  });

  it('prunes sends to a removed bus before re-declaring and compacts bus numbers', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const track = makeTrack(1, makeStrip({ sends: [{ busId: 'B', levelDb: -6, enabled: true }] }));

    sync.sync([track], makeMixer({ buses: [makeBus('A'), makeBus('B')] }));
    expect(engine.setTrackSends).toHaveBeenCalledWith(1, [
      { busId: 2, levelDb: -6, enabled: true },
    ]);
    clearCalls(engine);

    // Removing the referenced bus prunes the send first, then re-declares.
    sync.sync([track], makeMixer({ buses: [makeBus('A')] }));
    expect(engine.setTrackSends).toHaveBeenCalledTimes(1);
    expect(engine.setTrackSends).toHaveBeenCalledWith(1, []);
    expect(engine.setTrackBuses).toHaveBeenCalledTimes(1);
    expect(engine.setTrackBuses).toHaveBeenCalledWith([{ busId: 1, gainDb: 0 }]);
    expect(engine.setTrackSends.mock.invocationCallOrder[0]).toBeLessThan(
      engine.setTrackBuses.mock.invocationCallOrder[0],
    );
    clearCalls(engine);

    // A later bus reuses the freed visible meter/scope slot.
    sync.sync([track], makeMixer({ buses: [makeBus('A'), makeBus('C')] }));
    expect(sync.busIdFor('A')).toBe(1);
    expect(sync.busIdFor('B')).toBeUndefined();
    expect(sync.busIdFor('C')).toBe(2);
    expect(sync.busIdFor('D')).toBeUndefined();
    expect(engine.setTrackBuses).toHaveBeenCalledWith([
      { busId: 1, gainDb: 0 },
      { busId: 2, gainDb: 0 },
    ]);
  });

  it('clears the sends of a deleted track before re-declaring the bus set', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const track = makeTrack(
      1,
      makeStrip({ sends: [{ busId: 'A', levelDb: -6, enabled: true, timing: 'preFader' }] }),
    );

    sync.sync([track], makeMixer({ buses: [makeBus('A')] }));
    expect(engine.setTrackSends).toHaveBeenCalledWith(1, [
      { busId: 1, levelDb: -6, enabled: true, sendTiming: 'preFader' },
    ]);
    clearCalls(engine);

    // Deleting the track (its lane is only muted) must clear its lingering
    // pre-fader send before setTrackBuses runs, or it keeps feeding the bus.
    sync.sync([], makeMixer({ buses: [makeBus('A')] }));
    expect(engine.setTrackSends).toHaveBeenCalledTimes(1);
    expect(engine.setTrackSends).toHaveBeenCalledWith(1, []);
    expect(engine.setTrackSends.mock.invocationCallOrder[0]).toBeLessThan(
      engine.setTrackBuses.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    clearCalls(engine);

    // The stale send memory is dropped: a later sync does not re-clear it.
    sync.sync([], makeMixer({ buses: [makeBus('A')] }));
    expect(engine.setTrackSends).not.toHaveBeenCalled();
  });

  it('keeps replacement buses inside the engine bus telemetry range', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const initialBuses = Array.from({ length: MAX_ENGINE_BUSES }, (_, index) =>
      makeBus(`bus-${index + 1}`),
    );
    const replacementBuses = [...initialBuses.slice(1), makeBus('replacement')];
    const track = makeTrack(
      1,
      makeStrip({ sends: [{ busId: 'replacement', levelDb: -9, enabled: true }] }),
    );

    sync.sync([], makeMixer({ buses: initialBuses }));
    clearCalls(engine);
    sync.sync([track], makeMixer({ buses: replacementBuses }));

    expect(sync.busIdFor('bus-1')).toBeUndefined();
    expect(sync.busIdFor('bus-2')).toBe(1);
    expect(sync.busIdFor('replacement')).toBe(MAX_ENGINE_BUSES);
    expect(engine.setTrackBuses).toHaveBeenCalledWith(
      replacementBuses.map((_, index) => ({ busId: index + 1, gainDb: 0 })),
    );
    expect(engine.setTrackSends).toHaveBeenCalledWith(1, [
      { busId: MAX_ENGINE_BUSES, levelDb: -9, enabled: true },
    ]);
  });

  it('increments the bus mapping generation only when logical numbering changes', () => {
    const { handle } = makeHandle();
    const sync = createStripSync(handle);

    expect(sync.busMappingGeneration()).toBe(0);
    sync.sync([], makeMixer({ buses: [makeBus('A'), makeBus('B')] }));
    expect(sync.busMappingGeneration()).toBe(1);
    sync.sync([], makeMixer({ buses: [makeBus('A'), makeBus('B')] }));
    expect(sync.busMappingGeneration()).toBe(1);
    sync.sync([], makeMixer({ buses: [makeBus('B')] }));
    expect(sync.busMappingGeneration()).toBe(2);
    expect(sync.busIdFor('B')).toBe(1);
  });

  it('replaces a renumbered bus with a neutral scene instead of retaining prior DSP', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const processed = makeBus('processed');
    processed.strip = makeStrip({
      inserts: [{ processor: 'saturation.tape', params: { drive: 0.8 }, enabled: true }],
    });
    const clean = makeBus('clean');

    sync.sync([], makeMixer({ buses: [processed, clean] }));
    clearCalls(engine);
    sync.sync([], makeMixer({ buses: [clean] }));

    expect(sync.busIdFor('clean')).toBe(1);
    expect(engine.setBusStrip).toHaveBeenCalledWith(1, busScene(1, undefined));
  });

  it('clears bypass state when a new logical bus reuses a bus number', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const insert = { processor: 'saturation.tape', params: { drive: 0.8 } };
    const bypassed = {
      ...makeBus('bypassed'),
      strip: makeStrip({ inserts: [{ ...insert, enabled: false }] }),
    };
    const enabled = {
      ...makeBus('enabled'),
      strip: makeStrip({ inserts: [{ ...insert, enabled: true }] }),
    };

    sync.sync([], makeMixer({ buses: [bypassed, enabled] }));
    clearCalls(engine);
    sync.sync([], makeMixer({ buses: [enabled] }));

    expect(sync.busIdFor('enabled')).toBe(1);
    expect(engine.setBusInsertBypassed).toHaveBeenCalledWith(1, 0, { bypassed: false });
  });

  it('rejects more buses than the engine supports', () => {
    const { handle } = makeHandle();
    const sync = createStripSync(handle);
    const buses = Array.from({ length: MAX_ENGINE_BUSES + 1 }, (_, i) => makeBus(`bus-${i}`));

    expect(() => sync.sync([], makeMixer({ buses }))).toThrow(
      `Too many mixer buses for the engine: ${MAX_ENGINE_BUSES + 1} send buses + 0 group tracks > ${MAX_ENGINE_BUSES}`,
    );
  });

  it('dedupes unchanged sends', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const track = makeTrack(1, makeStrip({ sends: [{ busId: 'A', levelDb: -12, enabled: true }] }));

    sync.sync([track], makeMixer({ buses: [makeBus('A')] }));
    sync.sync([track], makeMixer({ buses: [makeBus('A')] }));
    expect(engine.setTrackSends).toHaveBeenCalledTimes(1);
  });
});

describe('busScene', () => {
  it('declares the bus with the submix role and its insert params', () => {
    const strip = makeStrip({
      inserts: [
        { processor: 'dynamics.compressor', params: { thresholdDb: -20 }, enabled: true },
        { processor: 'saturation.tape', params: { drive: 0.4 }, enabled: false },
      ],
    });
    expect(busScene(3, strip)).toEqual({
      id: 'bus-3',
      role: 'submix',
      inserts: [
        { slot: 'pre', processor: 'dynamics.compressor', params: { thresholdDb: -20 } },
        { slot: 'pre', processor: 'saturation.tape', params: { drive: 0.4 } },
      ],
    });
  });

  it('declares an empty bus strip for a missing strip', () => {
    expect(busScene(5, undefined)).toEqual({ id: 'bus-5', role: 'submix', inserts: [] });
  });

  it('emits the bus output trim, width, and polarity when non-default', () => {
    const strip = makeStrip({ inputTrimDb: -4, width: 1.5, polarityInvertLeft: true });
    expect(busScene(2, strip)).toEqual({
      id: 'bus-2',
      role: 'submix',
      inserts: [],
      inputTrimDb: -4,
      width: 1.5,
      polarityInvertLeft: true,
    });
  });

  it('omits the bus output trim, width, and polarity at their defaults', () => {
    const scene = busScene(2, makeStrip({ inputTrimDb: 0, width: 1 }));
    expect(scene).not.toHaveProperty('inputTrimDb');
    expect(scene).not.toHaveProperty('width');
    expect(scene).not.toHaveProperty('polarityInvertLeft');
    expect(scene).not.toHaveProperty('polarityInvertRight');
  });

  it('serializes non-default bus pan fields while omitting neutral panner defaults', () => {
    const strip = makeStrip({
      pan: 0.25,
      panLaw: 'linear0Db',
      panMode: 'dualPan',
      dualPan: { left: -0.5, right: 0.75 },
    });
    expect(busScene(2, strip)).toEqual({
      id: 'bus-2',
      role: 'submix',
      inserts: [],
      pan: 0.25,
      panMode: 'dualPan',
      dualPanLeft: -0.5,
      dualPanRight: 0.75,
      panLaw: 'linear0Db',
    });

    const neutral = busScene(2, makeStrip());
    expect(neutral).not.toHaveProperty('pan');
    expect(neutral).not.toHaveProperty('panMode');
    expect(neutral).not.toHaveProperty('dualPanLeft');
    expect(neutral).not.toHaveProperty('dualPanRight');
    expect(neutral).not.toHaveProperty('panLaw');
  });

  it('keeps stereo pan and width neutral for a surround bus', () => {
    const scene = busScene(
      2,
      makeStrip({
        width: 1.5,
        pan: 0.25,
        panMode: 'dualPan',
        panLaw: 'linear0Db',
        dualPan: { left: -0.5, right: 0.75 },
      }),
      null,
      { channelLayout: '5.1' },
    );
    expect(scene).toMatchObject({ id: 'bus-2', role: 'submix', layout: '5.1' });
    expect(scene).not.toHaveProperty('width');
    expect(scene).not.toHaveProperty('pan');
    expect(scene).not.toHaveProperty('panMode');
    expect(scene).not.toHaveProperty('dualPanLeft');
    expect(scene).not.toHaveProperty('dualPanRight');
    expect(scene).not.toHaveProperty('panLaw');
  });

  it('does not serialize inert bus EQ state into the bus scene by default', () => {
    const scene = busScene(
      2,
      makeStrip({
        eq: {
          enabled: true,
          bands: [{ enabled: true, type: 'peak', frequencyHz: 1200, gainDb: 4, q: 1 }],
        },
      }),
    );
    expect(scene).not.toHaveProperty('eq');
  });

  it('serializes bus EQ state when requested', () => {
    const band: EqBandInput = { enabled: true, type: 'peak', frequencyHz: 1200, gainDb: 4, q: 1 };
    const scene = busScene(
      2,
      makeStrip({
        eq: {
          enabled: true,
          bands: [band],
        },
      }),
      undefined,
      { includeEq: true },
    );
    expect(scene.eq).toEqual({ enabled: true, bands: [band] });
  });

  it('rejects a processor not in the insert catalog, unless the catalog is null', () => {
    const strip = makeStrip({ inserts: [{ processor: 'made.up', params: {}, enabled: true }] });
    expect(() => busScene(1, strip, new Set(['dynamics.compressor']))).toThrow(
      'Unsupported insert processor: made.up',
    );
    expect(() => busScene(1, strip, null)).not.toThrow();
  });
});

describe('groupBusGainDb', () => {
  it('stacks the track volume and strip gain in dB', () => {
    const track = makeGroupTrack(1, makeStrip({ gainDb: -2 }));
    track.volume = 0.5;
    expect(groupBusGainDb(track)).toBeCloseTo(linearToDb(0.5) - 2, 6);
    expect(groupBusGainDb(track, -6)).toBeCloseTo(linearToDb(0.5) - 2 - 6, 6);
  });

  it('is unity for a default group track without a strip', () => {
    expect(groupBusGainDb(makeGroupTrack(1))).toBe(0);
  });

  it('floors a muted group to silence', () => {
    const track = makeGroupTrack(1);
    track.mute = true;
    expect(groupBusGainDb(track)).toBe(-120);
  });

  it('clamps to the engine bus gain range', () => {
    const loud = makeGroupTrack(1, makeStrip({ gainDb: 24 }));
    loud.volume = 2;
    expect(groupBusGainDb(loud)).toBe(24);
    const silent = makeGroupTrack(2);
    silent.volume = 0;
    expect(groupBusGainDb(silent)).toBe(-120);
  });
});

describe('createStripSync group routing', () => {
  it('allocates one engine bus per group track after the user buses and routes members', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const group = makeGroupTrack(10);
    const member = { ...makeTrack(1), groupId: 10 };

    sync.sync([member, group], makeMixer({ buses: [makeBus('A', -3)] }));
    expect(engine.setTrackBuses).toHaveBeenCalledTimes(1);
    expect(engine.setTrackBuses).toHaveBeenCalledWith([
      { busId: 1, gainDb: -3 },
      { busId: 2, gainDb: 0 },
    ]);
    expect(engine.setTrackOutputBus).toHaveBeenCalledTimes(1);
    expect(engine.setTrackOutputBus).toHaveBeenCalledWith(1, 2);
    clearCalls(engine);

    // Unchanged state stays silent.
    sync.sync([member, group], makeMixer({ buses: [makeBus('A', -3)] }));
    expect(totalCalls(engine)).toBe(0);
  });

  it('folds a group track VCA offset into its group bus gain', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const group = { ...makeGroupTrack(10), vcaId: 'vca-1' };

    sync.sync([group], makeMixer({ vcaGroups: [{ id: 'vca-1', name: 'Group VCA', gainDb: -6 }] }));
    expect(engine.setTrackBuses).toHaveBeenCalledTimes(1);
    expect(engine.setTrackBuses).toHaveBeenCalledWith([{ busId: 1, gainDb: -6 }]);
  });

  it('folds a group track VCA mute into its group bus gain', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const group = { ...makeGroupTrack(10), vcaId: 'vca-1' };

    sync.sync(
      [group],
      makeMixer({ vcaGroups: [{ id: 'vca-1', name: 'Group VCA', gainDb: 0, mute: true }] }),
    );

    expect(engine.setTrackBuses).toHaveBeenCalledWith([{ busId: 1, gainDb: -120 }]);
  });

  it('compacts group bus numbers after user buses are added later', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);

    sync.sync([makeGroupTrack(10)], makeMixer());
    expect(engine.setTrackBuses).toHaveBeenLastCalledWith([{ busId: 1, gainDb: 0 }]);

    sync.sync([makeGroupTrack(10)], makeMixer({ buses: [makeBus('A')] }));
    expect(engine.setTrackBuses).toHaveBeenLastCalledWith([
      { busId: 1, gainDb: 0 },
      { busId: 2, gainDb: 0 },
    ]);
  });

  it('sends user bus inserts via the bus strip and clears them when removed', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const inserts = [
      { processor: 'dynamics.compressor', params: { thresholdDb: -20 }, enabled: true },
      { processor: 'saturation.tape', params: { drive: 0.4 }, enabled: false },
    ];
    const bus = { ...makeBus('FX'), strip: makeStrip({ inserts }) };

    sync.sync([], makeMixer({ buses: [bus] }));
    expect(engine.setBusStrip).toHaveBeenCalledTimes(1);
    expect(engine.setBusStrip).toHaveBeenCalledWith(1, busScene(1, makeStrip({ inserts })));
    expect(engine.setBusInsertBypassed).toHaveBeenCalledWith(1, 1, { bypassed: true });
    clearCalls(engine);

    sync.sync([], makeMixer({ buses: [{ ...makeBus('FX'), strip: makeStrip() }] }));
    expect(engine.setBusStrip).toHaveBeenCalledWith(1, busScene(1, makeStrip()));
  });

  it('sends user bus EQ through the bus EQ setter, not the track/master one', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const bus = {
      ...makeBus('FX'),
      strip: makeStrip({
        eq: {
          enabled: true,
          bands: [{ enabled: true, type: 'peak', frequencyHz: 1200, gainDb: 4, q: 1 }],
        },
      }),
    };

    sync.sync([], makeMixer({ buses: [bus] }));

    expect(engine.setStripEqBand).not.toHaveBeenCalled();
    expect(engine.setBusEqBand).toHaveBeenCalledWith(1, 0, {
      enabled: true,
      type: 'peak',
      frequencyHz: 1200,
      gainDb: 4,
      q: 1,
    });
  });

  it('sends and diffs user bus EQ when the bus EQ ABI exists', () => {
    const { handle, engine } = makeHandle();
    engine.setBusEqBand = vi.fn(function (this: unknown) {
      expect(this).toBe(engine);
    });
    const sync = createStripSync(handle);
    const band: EqBandInput = { enabled: true, type: 'peak', frequencyHz: 1200, gainDb: 4, q: 1 };
    const edited: EqBandInput = { ...band, gainDb: 2 };
    const busFor = (bands: EqBandInput[]): MixerBus => ({
      ...makeBus('FX'),
      strip: makeStrip({ eq: { enabled: true, bands } }),
    });

    sync.sync([], makeMixer({ buses: [busFor([band])] }));

    expect(engine.setBusStrip).toHaveBeenCalledWith(
      1,
      busScene(1, busFor([band]).strip, null, { includeEq: true }),
    );
    expect(engine.setBusEqBand).toHaveBeenCalledWith(1, 0, band);
    clearCalls(engine);

    sync.sync([], makeMixer({ buses: [busFor([edited])] }));
    expect(engine.setBusStrip).not.toHaveBeenCalled();
    expect(engine.setBusEqBand).toHaveBeenCalledWith(1, 0, edited);
    clearCalls(engine);

    sync.sync([], makeMixer({ buses: [busFor([])] }));
    expect(engine.setBusEqBand).toHaveBeenCalledWith(1, 0, { enabled: false });
  });

  it('sends and diffs bus pan scalars in place without rebuilding inserts', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const busFor = (overrides: Partial<MixerStrip>): MixerBus => ({
      ...makeBus('FX'),
      strip: makeStrip({
        inserts: [{ processor: 'effects.reverb.fdn', params: { dryWet: 0.4 }, enabled: true }],
        ...overrides,
      }),
    });
    const initial = busFor({
      pan: 0.25,
      panLaw: 'linear0Db',
      panMode: 'dualPan',
      dualPan: { left: -0.5, right: 0.75 },
    });

    sync.sync([], makeMixer({ buses: [initial] }));
    expect(engine.setBusStrip).toHaveBeenCalledTimes(1);
    expect(engine.setBusStrip.mock.calls[0][1]).toMatchObject({
      pan: 0.25,
      panLaw: 'linear0Db',
      panMode: 'dualPan',
      dualPanLeft: -0.5,
      dualPanRight: 0.75,
    });
    clearCalls(engine);

    const edited = busFor({
      pan: -0.4,
      panLaw: 'const6Db',
      panMode: 'stereoPan',
      dualPan: { left: -0.25, right: 0.5 },
    });
    sync.sync([], makeMixer({ buses: [edited] }));

    // The insert chain is retained; only changed panner controls cross the
    // command boundary, preserving stateful insert tails.
    expect(engine.setBusStrip).not.toHaveBeenCalled();
    expect(engine.setBusPan).toHaveBeenCalledWith(1, -0.4);
    expect(engine.setBusPanLaw).toHaveBeenCalledWith(1, 'const6Db');
    expect(engine.setBusPanMode).toHaveBeenCalledWith(1, 'stereoPan');
    expect(engine.setBusDualPan).toHaveBeenCalledWith(1, -0.25, 0.5);
    clearCalls(engine);

    // Returning to the engine defaults is also an in-place update. It must
    // restore the panner identity rather than leaving the previous bus state.
    sync.sync([], makeMixer({ buses: [busFor({})] }));
    expect(engine.setBusStrip).not.toHaveBeenCalled();
    expect(engine.setBusPan).toHaveBeenCalledWith(1, 0);
    expect(engine.setBusPanLaw).toHaveBeenCalledWith(1, 'const3Db');
    expect(engine.setBusPanMode).toHaveBeenCalledWith(1, 'balance');
    expect(engine.setBusDualPan).toHaveBeenCalledWith(1, -1, 1);
  });

  it('replays a neutral bus scene after a bus-number remap clears prior pan and EQ', () => {
    const { handle, engine } = makeHandle();
    engine.setBusEqBand = vi.fn();
    const sync = createStripSync(handle);
    const processed = {
      ...makeBus('processed'),
      strip: makeStrip({
        pan: -0.5,
        eq: {
          enabled: true,
          bands: [{ enabled: true, type: 'peak', frequencyHz: 900, gainDb: 4, q: 1 }],
        },
      }),
    };
    const clean = makeBus('clean');

    sync.sync([], makeMixer({ buses: [processed, clean] }));
    clearCalls(engine);
    sync.sync([], makeMixer({ buses: [clean] }));

    expect(engine.setBusStrip).toHaveBeenCalledWith(1, busScene(1, undefined));
    expect(engine.setBusPan).not.toHaveBeenCalled();
    expect(engine.setBusEqBand).not.toHaveBeenCalled();
  });

  it('patches enabled user bus insert numeric params without replacing the bus strip', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const busFor = (thresholdDb: number): MixerBus => ({
      ...makeBus('FX'),
      strip: makeStrip({
        inserts: [
          { processor: 'gate.expander', params: { floorDb: -80 }, enabled: false },
          { processor: 'dynamics.compressor', params: { thresholdDb }, enabled: true },
        ],
      }),
    });

    sync.sync([], makeMixer({ buses: [busFor(-20)] }));
    clearCalls(engine);

    sync.sync([], makeMixer({ buses: [busFor(-12)] }));
    expect(engine.setBusStrip).not.toHaveBeenCalled();
    expect(engine.setBusInsertParam).toHaveBeenCalledTimes(1);
    expect(engine.setBusInsertParam).toHaveBeenCalledWith(1, 1, {
      name: 'thresholdDb',
      value: -12,
    });
  });

  it('uses bus insert bypass ABI for user bus enable toggles when available', () => {
    const { handle, engine } = makeHandle();
    engine.setBusInsertBypassed = vi.fn(function (this: unknown) {
      expect(this).toBe(engine);
    });
    const sync = createStripSync(handle);
    const inserts = [
      { processor: 'dynamics.compressor', params: { thresholdDb: -20 }, enabled: true },
      { processor: 'saturation.tape', params: { drive: 0.4 }, enabled: false },
    ];
    const bus = { ...makeBus('FX'), strip: makeStrip({ inserts }) };

    sync.sync([], makeMixer({ buses: [bus] }));
    expect(engine.setBusStrip).toHaveBeenCalledWith(1, busScene(1, makeStrip({ inserts })));
    expect(engine.setBusInsertBypassed).toHaveBeenCalledWith(1, 1, { bypassed: true });
    clearCalls(engine);

    const toggled = inserts.map((slot, index) => (index === 1 ? { ...slot, enabled: true } : slot));
    sync.sync(
      [],
      makeMixer({ buses: [{ ...makeBus('FX'), strip: makeStrip({ inserts: toggled }) }] }),
    );

    expect(engine.setBusStrip).not.toHaveBeenCalled();
    expect(engine.setBusInsertBypassed).toHaveBeenCalledTimes(1);
    expect(engine.setBusInsertBypassed).toHaveBeenCalledWith(1, 1, { bypassed: false });
  });

  it('provides ABI-correct automation indexes for return-bus inserts', () => {
    const inserts = [
      { processor: 'gate.expander', params: {}, enabled: false },
      { processor: 'dynamics.compressor', params: {}, enabled: true },
    ];
    const bus = { ...makeBus('FX'), strip: makeStrip({ inserts }) };

    const sync = createStripSync(makeHandle().handle);
    sync.sync([], makeMixer({ buses: [bus] }));
    expect(sync.busInsertIndexFor('FX', 0)).toBe(0);
    expect(sync.busInsertIndexFor('FX', 1)).toBe(1);
  });

  it('routes a member back to the master mix when its membership clears', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const group = makeGroupTrack(10);

    sync.sync([{ ...makeTrack(1), groupId: 10 }, group], makeMixer());
    expect(engine.setTrackOutputBus).toHaveBeenCalledWith(1, 1);
    clearCalls(engine);

    sync.sync([makeTrack(1), group], makeMixer());
    expect(engine.setTrackOutputBus).toHaveBeenCalledTimes(1);
    expect(engine.setTrackOutputBus).toHaveBeenCalledWith(1, null);
  });

  it('rejects more send buses plus group tracks than the engine supports', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const buses = Array.from({ length: 7 }, (_, i) => makeBus(`bus-${i}`));
    const groups = [makeGroupTrack(20), makeGroupTrack(21)];

    expect(() => sync.sync(groups, makeMixer({ buses }))).toThrow(
      `Too many mixer buses for the engine: 7 send buses + 2 group tracks > ${MAX_ENGINE_BUSES}`,
    );
    expect(totalCalls(engine)).toBe(0);
  });

  it('declares every group insert via the bus strip and re-sends only on structural changes', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const inserts = [
      { processor: 'dynamics.compressor', params: { thresholdDb: -20 }, enabled: true },
      { processor: 'saturation.tape', params: { drive: 0.4 }, enabled: false },
    ];

    sync.sync([makeGroupTrack(10, makeStrip({ inserts }))], makeMixer());
    expect(engine.setStrip).not.toHaveBeenCalled();
    expect(engine.setStripInsertBypassed).not.toHaveBeenCalled();
    expect(engine.setBusStrip).toHaveBeenCalledTimes(1);
    expect(engine.setBusStrip).toHaveBeenCalledWith(1, busScene(1, makeStrip({ inserts })));
    expect(engine.setBusInsertBypassed).toHaveBeenCalledTimes(2);
    clearCalls(engine);

    // Unchanged state stays silent.
    sync.sync([makeGroupTrack(10, makeStrip({ inserts }))], makeMixer());
    expect(totalCalls(engine)).toBe(0);

    // Swapping a processor re-sends the whole bus scene.
    const swapped = [inserts[0], { ...inserts[1], processor: 'saturation.softClipper' }];
    sync.sync([makeGroupTrack(10, makeStrip({ inserts: swapped }))], makeMixer());
    expect(engine.setBusStrip).toHaveBeenCalledTimes(1);
    expect(engine.setBusStrip).toHaveBeenCalledWith(
      1,
      busScene(1, makeStrip({ inserts: swapped })),
    );
  });

  it('uses bus insert bypass ABI for group bus enable toggles when available', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const inserts = [
      { processor: 'dynamics.compressor', params: { thresholdDb: -20 }, enabled: true },
      { processor: 'saturation.tape', params: { drive: 0.4 }, enabled: false },
    ];
    const group = makeGroupTrack(10, makeStrip({ inserts }));

    sync.sync([group], makeMixer());
    expect(engine.setBusStrip).toHaveBeenCalledWith(1, busScene(1, makeStrip({ inserts })));
    expect(engine.setBusInsertBypassed).toHaveBeenCalledWith(1, 1, { bypassed: true });
    clearCalls(engine);

    const toggled = inserts.map((slot, index) => (index === 1 ? { ...slot, enabled: true } : slot));
    sync.sync([makeGroupTrack(10, makeStrip({ inserts: toggled }))], makeMixer());

    expect(engine.setBusStrip).not.toHaveBeenCalled();
    expect(engine.setBusInsertBypassed).toHaveBeenCalledTimes(1);
    expect(engine.setBusInsertBypassed).toHaveBeenCalledWith(1, 1, { bypassed: false });
  });

  it('provides ABI-correct automation indexes for group inserts', () => {
    const inserts = [
      { processor: 'gate.expander', params: {}, enabled: false },
      { processor: 'dynamics.compressor', params: {}, enabled: true },
    ];
    const group = makeGroupTrack(10, makeStrip({ inserts }));

    const sync = createStripSync(makeHandle().handle);
    sync.sync([group], makeMixer());
    expect(sync.groupInsertIndexFor(10, 0)).toBe(0);
    expect(sync.groupInsertIndexFor(10, 1)).toBe(1);
  });

  it('patches enabled group insert numeric params without replacing the group bus strip', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const groupFor = (thresholdDb: number): EditorTrack =>
      makeGroupTrack(
        10,
        makeStrip({
          inserts: [
            { processor: 'gate.expander', params: { floorDb: -80 }, enabled: false },
            { processor: 'dynamics.compressor', params: { thresholdDb }, enabled: true },
          ],
        }),
      );

    sync.sync([groupFor(-20)], makeMixer());
    clearCalls(engine);

    sync.sync([groupFor(-12)], makeMixer());
    expect(engine.setBusStrip).not.toHaveBeenCalled();
    expect(engine.setBusInsertParam).toHaveBeenCalledTimes(1);
    expect(engine.setBusInsertParam).toHaveBeenCalledWith(1, 1, {
      name: 'thresholdDb',
      value: -12,
    });
  });

  it('re-sends the bus strip when only its output trim changes', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const inserts = [{ processor: 'dynamics.compressor', params: {}, enabled: true }];

    sync.sync([makeGroupTrack(10, makeStrip({ inserts }))], makeMixer());
    clearCalls(engine);

    // A trim-only edit (no insert change) must still re-send the bus scene.
    sync.sync([makeGroupTrack(10, makeStrip({ inserts, inputTrimDb: -3 }))], makeMixer());
    expect(engine.setBusStrip).toHaveBeenCalledTimes(1);
    expect(engine.setBusStrip).toHaveBeenCalledWith(
      1,
      busScene(1, makeStrip({ inserts, inputTrimDb: -3 })),
    );
    clearCalls(engine);

    // Re-applying the same trimmed state stays silent.
    sync.sync([makeGroupTrack(10, makeStrip({ inserts, inputTrimDb: -3 }))], makeMixer());
    expect(engine.setBusStrip).not.toHaveBeenCalled();
  });

  it('adjusts only the bus gain when the audible group level changes', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const inserts = [{ processor: 'dynamics.compressor', params: {}, enabled: true }];

    sync.sync([makeGroupTrack(10, makeStrip({ inserts }))], makeMixer());
    clearCalls(engine);

    const quieter = makeGroupTrack(10, makeStrip({ inserts }));
    quieter.volume = 0.5;
    sync.sync([quieter], makeMixer());
    expect(engine.setTrackBuses).not.toHaveBeenCalled();
    expect(engine.setBusStrip).not.toHaveBeenCalled();
    expect(engine.setBusGainDb).toHaveBeenCalledTimes(1);
    const [busId, gainDb] = engine.setBusGainDb.mock.calls[0] as [number, number];
    expect(busId).toBe(1);
    expect(gainDb).toBeCloseTo(linearToDb(0.5), 6);
    clearCalls(engine);

    const muted = makeGroupTrack(10, makeStrip({ inserts }));
    muted.volume = 0.5;
    muted.mute = true;
    sync.sync([muted], makeMixer());
    expect(engine.setBusGainDb).toHaveBeenCalledTimes(1);
    expect(engine.setBusGainDb).toHaveBeenCalledWith(1, -120);
  });
});

describe('createStripSync output-bus routing', () => {
  it('routes a non-grouped track strip to its chosen send bus', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);

    sync.sync(
      [makeTrack(1, makeStrip({ outputBusId: 'A' }))],
      makeMixer({ buses: [makeBus('A')] }),
    );
    expect(engine.setTrackOutputBus).toHaveBeenCalledTimes(1);
    expect(engine.setTrackOutputBus).toHaveBeenCalledWith(1, 1);
    clearCalls(engine);

    // Unchanged routing stays silent.
    sync.sync(
      [makeTrack(1, makeStrip({ outputBusId: 'A' }))],
      makeMixer({ buses: [makeBus('A')] }),
    );
    expect(totalCalls(engine)).toBe(0);
  });

  it('lets group membership win over a user-chosen output bus', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const group = makeGroupTrack(10);
    const member = { ...makeTrack(1, makeStrip({ outputBusId: 'A' })), groupId: 10 };

    // Bus 'A' is engine bus 1, the group bus is 2; the member routes to 2.
    sync.sync([member, group], makeMixer({ buses: [makeBus('A')] }));
    expect(engine.setTrackOutputBus).toHaveBeenCalledWith(1, 2);
  });

  it('routes back to the master mix when the output bus is cleared', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);

    sync.sync(
      [makeTrack(1, makeStrip({ outputBusId: 'A' }))],
      makeMixer({ buses: [makeBus('A')] }),
    );
    expect(engine.setTrackOutputBus).toHaveBeenCalledWith(1, 1);
    clearCalls(engine);

    sync.sync([makeTrack(1)], makeMixer({ buses: [makeBus('A')] }));
    expect(engine.setTrackOutputBus).toHaveBeenCalledTimes(1);
    expect(engine.setTrackOutputBus).toHaveBeenCalledWith(1, null);
  });

  it('falls back to the master mix when the output bus is no longer declared', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);

    sync.sync(
      [makeTrack(1, makeStrip({ outputBusId: 'A' }))],
      makeMixer({ buses: [makeBus('A')] }),
    );
    expect(engine.setTrackOutputBus).toHaveBeenCalledWith(1, 1);
    clearCalls(engine);

    // The bus is removed but the strip still names it: route back to master,
    // never to an undeclared bus (the engine rejects that lane).
    sync.sync([makeTrack(1, makeStrip({ outputBusId: 'A' }))], makeMixer());
    expect(engine.setTrackOutputBus).toHaveBeenCalledWith(1, null);
  });

  it('clears old output routes before a compact bus-number remap', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const track = makeTrack(1, makeStrip({ outputBusId: 'B' }));

    sync.sync([track], makeMixer({ buses: [makeBus('A'), makeBus('B')] }));
    clearCalls(engine);

    // B moves from engine bus 2 to 1. Native set_buses validates the current
    // lane output before replacing the bus list, so the old route must be
    // cleared first and replayed only after the declaration is accepted.
    sync.sync([track], makeMixer({ buses: [makeBus('B')] }));
    expect(engine.setTrackOutputBus).toHaveBeenNthCalledWith(1, 1, null);
    expect(engine.setTrackOutputBus).toHaveBeenNthCalledWith(2, 1, 1);
    expect(engine.setTrackOutputBus.mock.invocationCallOrder[0]).toBeLessThan(
      engine.setTrackBuses.mock.invocationCallOrder[0],
    );
    expect(engine.setTrackBuses.mock.invocationCallOrder[0]).toBeLessThan(
      engine.setTrackOutputBus.mock.invocationCallOrder[1],
    );
  });

  it('clears a retired lane route before forgetting it', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const track = makeTrack(1, makeStrip({ outputBusId: 'A' }));

    sync.sync([track], makeMixer({ buses: [makeBus('A')] }));
    clearCalls(engine);

    // Mixer lanes are retained after a track is deleted, so the route must be
    // detached even while the destination bus still exists.
    sync.sync([], makeMixer({ buses: [makeBus('A')] }));
    expect(engine.setTrackOutputBus).toHaveBeenCalledWith(1, null);
    clearCalls(engine);

    // Removing the now-unused bus must remain valid on the retained lane.
    expect(() => sync.sync([], makeMixer())).not.toThrow();
    expect(engine.setTrackBuses).toHaveBeenCalledWith([]);
  });

  it('clears numeric sends before a logical bus remap and replays them after', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const track = makeTrack(1, makeStrip({ sends: [{ busId: 'B', levelDb: -6, enabled: true }] }));

    sync.sync([track], makeMixer({ buses: [makeBus('A'), makeBus('B')] }));
    clearCalls(engine);

    // B moves from numeric id 2 to 1 while id 2 is reused by C. Do not let
    // the old numeric send alias C during setTrackBuses.
    sync.sync([track], makeMixer({ buses: [makeBus('B'), makeBus('C')] }));
    expect(engine.setTrackSends).toHaveBeenNthCalledWith(1, 1, []);
    expect(engine.setTrackSends).toHaveBeenNthCalledWith(2, 1, [
      { busId: 1, levelDb: -6, enabled: true },
    ]);
    expect(engine.setTrackSends.mock.invocationCallOrder[0]).toBeLessThan(
      engine.setTrackBuses.mock.invocationCallOrder[0],
    );
    expect(engine.setTrackBuses.mock.invocationCallOrder[0]).toBeLessThan(
      engine.setTrackSends.mock.invocationCallOrder[1],
    );
  });

  it('ignores an output bus set on a group track itself', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);

    sync.sync(
      [makeGroupTrack(10, makeStrip({ outputBusId: 'A' }))],
      makeMixer({ buses: [makeBus('A')] }),
    );
    // The group track's own lane stays on the master mix (its bus carries the
    // submix); no lane is routed to bus 'A'.
    expect(engine.setTrackOutputBus).not.toHaveBeenCalled();
  });
});

describe('createStripSync sidechain bindings', () => {
  /** Strip with one enabled insert, optionally keyed from a source track. */
  function keyedStrip(source?: number): MixerStrip {
    return makeStrip({
      inserts: [
        {
          processor: 'dynamics.compressor',
          params: {},
          enabled: true,
          ...(source !== undefined ? { sidechainSourceTrackId: source } : {}),
        },
      ],
    });
  }

  it('binds insert sidechains once, rebinds on source change and clears removed ones', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);

    sync.sync([makeTrack(1, keyedStrip(2)), makeTrack(2), makeTrack(3)], makeMixer());
    expect(engine.setStripSidechain).toHaveBeenCalledTimes(1);
    expect(engine.setStripSidechain).toHaveBeenCalledWith(1, 0, { kind: 'track', id: 2 });
    engine.setStripSidechain.mockClear();

    // Unchanged binding stays silent.
    sync.sync([makeTrack(1, keyedStrip(2)), makeTrack(2), makeTrack(3)], makeMixer());
    expect(engine.setStripSidechain).not.toHaveBeenCalled();

    // A source change rebinds directly, without an intermediate clear.
    sync.sync([makeTrack(1, keyedStrip(3)), makeTrack(2), makeTrack(3)], makeMixer());
    expect(engine.setStripSidechain).toHaveBeenCalledTimes(1);
    expect(engine.setStripSidechain).toHaveBeenCalledWith(1, 0, { kind: 'track', id: 3 });
    engine.setStripSidechain.mockClear();

    // Removing the binding clears the engine-side key with null.
    sync.sync([makeTrack(1, keyedStrip()), makeTrack(2), makeTrack(3)], makeMixer());
    expect(engine.setStripSidechain).toHaveBeenCalledTimes(1);
    expect(engine.setStripSidechain).toHaveBeenCalledWith(1, 0, null);
  });

  it('binds group tracks as sidechain sources but ignores self, unknown and group-strip targets', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);

    sync.sync(
      [
        makeTrack(1, keyedStrip(1)),
        makeTrack(2, keyedStrip(99)),
        makeTrack(3, keyedStrip(10)),
        makeGroupTrack(10, keyedStrip(1)),
      ],
      makeMixer(),
    );
    expect(engine.setStripSidechain).toHaveBeenCalledTimes(1);
    expect(engine.setStripSidechain).toHaveBeenCalledWith(3, 0, { kind: 'track', id: 10 });
  });

  it('clears a key before its strip is replaced by a shorter one', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    sync.sync([makeTrack(1, keyedStrip(2)), makeTrack(2)], makeMixer());
    engine.setStripSidechain.mockClear();
    engine.setStrip.mockClear();

    sync.sync([makeTrack(1, makeStrip()), makeTrack(2)], makeMixer());

    expect(engine.setStripSidechain).toHaveBeenCalledTimes(1);
    expect(engine.setStripSidechain).toHaveBeenCalledWith(1, 0, null);
    expect(engine.setStripSidechain.mock.invocationCallOrder[0]).toBeLessThan(
      engine.setStrip.mock.invocationCallOrder[0],
    );
  });

  it('clears the key on freeze and re-applies it on unfreeze', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const live = [makeTrack(1, keyedStrip(2)), makeTrack(2)];
    const frozen = [{ ...makeTrack(1, keyedStrip(2)), frozen: { assetId: 'a' } }, makeTrack(2)];
    sync.sync(live, makeMixer());
    engine.setStripSidechain.mockClear();
    engine.setStrip.mockClear();

    sync.sync(frozen, makeMixer());
    expect(engine.setStripSidechain.mock.calls).toEqual([[1, 0, null]]);
    expect(engine.setStripSidechain.mock.invocationCallOrder[0]).toBeLessThan(
      engine.setStrip.mock.invocationCallOrder[0],
    );
    engine.setStripSidechain.mockClear();

    sync.sync(live, makeMixer());
    expect(engine.setStripSidechain.mock.calls).toEqual([[1, 0, { kind: 'track', id: 2 }]]);
  });

  it('clears a binding whose source track disappears', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);

    sync.sync([makeTrack(1, keyedStrip(2)), makeTrack(2)], makeMixer());
    engine.setStripSidechain.mockClear();

    sync.sync([makeTrack(1, keyedStrip(2))], makeMixer());
    expect(engine.setStripSidechain).toHaveBeenCalledTimes(1);
    expect(engine.setStripSidechain).toHaveBeenCalledWith(1, 0, null);
  });

  it('binds and diffs bus and master strip sidechains', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const busStrip = (source: number | undefined): MixerStrip =>
      makeStrip({
        inserts: [
          {
            processor: 'dynamics.compressor',
            params: {},
            enabled: true,
            ...(source === undefined ? {} : { sidechainSourceTrackId: source }),
          },
        ],
      });

    sync.sync(
      [makeTrack(1), makeTrack(2), makeTrack(3)],
      makeMixer({ buses: [{ ...makeBus('A'), strip: busStrip(2) }], master: busStrip(2) }),
    );
    expect(engine.setBusSidechain).toHaveBeenCalledWith(1, 0, { kind: 'track', id: 2 });
    expect(engine.setStripSidechain).toHaveBeenCalledWith('master', 0, { kind: 'track', id: 2 });
    engine.setBusSidechain.mockClear();
    engine.setStripSidechain.mockClear();

    sync.sync(
      [makeTrack(1), makeTrack(2), makeTrack(3)],
      makeMixer({ buses: [{ ...makeBus('A'), strip: busStrip(3) }], master: busStrip(3) }),
    );
    expect(engine.setBusSidechain).toHaveBeenCalledWith(1, 0, { kind: 'track', id: 3 });
    expect(engine.setStripSidechain).toHaveBeenCalledWith('master', 0, { kind: 'track', id: 3 });
    engine.setBusSidechain.mockClear();
    engine.setStripSidechain.mockClear();

    sync.sync(
      [makeTrack(1), makeTrack(2), makeTrack(3)],
      makeMixer({
        buses: [{ ...makeBus('A'), strip: busStrip(undefined) }],
        master: busStrip(undefined),
      }),
    );
    expect(engine.setBusSidechain).toHaveBeenCalledWith(1, 0, null);
    expect(engine.setStripSidechain).toHaveBeenCalledWith('master', 0, null);
  });

  it('maps bus and group-track sidechain sources after bus numbering', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const busSourceStrip = makeStrip({
      inserts: [
        {
          processor: 'dynamics.compressor',
          params: {},
          enabled: true,
          sidechainSourceBusId: 'B',
        },
      ],
    });
    const groupSourceStrip = makeStrip({
      inserts: [
        {
          processor: 'dynamics.compressor',
          params: {},
          enabled: true,
          sidechainSourceGroupTrackId: 20,
        },
      ],
    });

    sync.sync(
      [makeGroupTrack(10, groupSourceStrip), makeGroupTrack(20)],
      makeMixer({
        buses: [{ ...makeBus('A'), strip: busSourceStrip }, makeBus('B')],
      }),
    );
    expect(engine.setBusSidechain).toHaveBeenCalledWith(1, 0, { kind: 'bus', id: 2 });
    // Group buses follow user buses in the compact numbering.
    expect(engine.setBusSidechain).toHaveBeenCalledWith(3, 0, { kind: 'bus', id: 4 });
  });
});

describe('createStripSync bus gain refusal', () => {
  it('re-sends a bus gain the engine ring refused', () => {
    vi.useFakeTimers();
    try {
      const { handle, engine } = makeHandle();
      const sync = createStripSync(handle);
      const tracks = [makeTrack(1)];
      sync.sync(tracks, makeMixer({ buses: [makeBus('A', 0)] }));
      engine.setBusGainDb.mockClear();
      engine.setBusGainDb.mockImplementationOnce(() => {
        throw new SonareError(ErrorCode.OutOfMemory, 'command ring full');
      });

      sync.sync(tracks, makeMixer({ buses: [makeBus('A', -6)] }));
      expect(engine.setBusGainDb).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(200);
      expect(engine.setBusGainDb.mock.calls).toEqual([
        [1, -6],
        [1, -6],
      ]);
      vi.advanceTimersByTime(500);
      expect(engine.setBusGainDb).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
