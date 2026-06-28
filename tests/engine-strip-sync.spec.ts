import { describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import { linearToDb } from '@/engine/mixer-sync';
import {
  busSceneJson,
  createStripSync,
  groupBusGainDb,
  MAX_ENGINE_BUSES,
  stripSceneJson,
} from '@/engine/strip-sync';
import {
  createDefaultMixerState,
  createDefaultStrip,
  type MixerBus,
  type MixerStrip,
  type ProjectMixerState,
} from '@/project/mixer';
import type { EditorTrack } from '@/project/types';
import type { EqBand } from '@/wasm/index.js';

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
    setTrackStripJson: ReturnType<typeof vi.fn>;
    setMasterStripJson: ReturnType<typeof vi.fn>;
    setStripEq: ReturnType<typeof vi.fn>;
    setStripInsertBypassed: ReturnType<typeof vi.fn>;
    setTrackBuses: ReturnType<typeof vi.fn>;
    setBusGain: ReturnType<typeof vi.fn>;
    setSends: ReturnType<typeof vi.fn>;
    setTrackOutputBus: ReturnType<typeof vi.fn>;
    setBusStripJson: ReturnType<typeof vi.fn>;
    setLaneSidechain: ReturnType<typeof vi.fn>;
  };
} {
  const engine = {
    setTrackStripJson: vi.fn(),
    setMasterStripJson: vi.fn(),
    setStripEq: vi.fn(),
    setStripInsertBypassed: vi.fn(),
    setTrackBuses: vi.fn(),
    setBusGain: vi.fn(),
    setSends: vi.fn(),
    setTrackOutputBus: vi.fn(),
    setBusStripJson: vi.fn(),
    setLaneSidechain: vi.fn(),
  };
  const handle = { engine } as unknown as EngineHandle;
  return { handle, engine };
}

/** Total number of engine calls captured across all stubbed methods. */
function totalCalls(engine: ReturnType<typeof makeHandle>['engine']): number {
  return Object.values(engine).reduce((sum, fn) => sum + fn.mock.calls.length, 0);
}

/** Clears all captured engine calls. */
function clearCalls(engine: ReturnType<typeof makeHandle>['engine']): void {
  for (const fn of Object.values(engine)) fn.mockClear();
}

describe('stripSceneJson', () => {
  it('declares all inserts (enabled and disabled) with stringified params', () => {
    const strip = makeStrip({
      inserts: [
        { processor: 'dynamics.compressor', params: { thresholdDb: -20 }, enabled: true },
        { processor: 'saturation.tape', params: { drive: 0.4 }, enabled: false },
      ],
    });
    expect(JSON.parse(stripSceneJson(7, strip))).toEqual({
      version: 1,
      strips: [
        {
          id: 'track-7',
          inserts: [
            { slot: 'pre', processor: 'dynamics.compressor', params: '{"thresholdDb":-20}' },
            { slot: 'pre', processor: 'saturation.tape', params: '{"drive":0.4}' },
          ],
        },
      ],
      buses: [],
      connections: [],
    });
  });

  it('declares strip-local trim width and polarity fields', () => {
    const strip = makeStrip({
      inputTrimDb: 3,
      width: 0.5,
      polarityInvertRight: true,
    });
    expect(JSON.parse(stripSceneJson(7, strip))).toEqual({
      version: 1,
      strips: [
        {
          id: 'track-7',
          inserts: [],
          inputTrimDb: 3,
          width: 0.5,
          polarityInvertRight: true,
        },
      ],
      buses: [],
      connections: [],
    });
  });

  it('uses the master strip id for the master target', () => {
    const parsed = JSON.parse(stripSceneJson('master', makeStrip())) as {
      strips: Array<{ id: string }>;
    };
    expect(parsed.strips[0].id).toBe('master');
  });

  it('declares an empty strip for a missing strip', () => {
    expect(JSON.parse(stripSceneJson(3, undefined))).toEqual({
      version: 1,
      strips: [{ id: 'track-3', inserts: [] }],
      buses: [],
      connections: [],
    });
  });

  it('rejects a processor not in the insert catalog', () => {
    const strip = makeStrip({
      inserts: [{ processor: 'saturation.tape', params: {}, enabled: true }],
    });
    expect(() => stripSceneJson(1, strip, new Set(['dynamics.compressor']))).toThrow(
      'Unsupported insert processor: saturation.tape',
    );
  });

  it('skips validation when the catalog is null', () => {
    const strip = makeStrip({
      inserts: [{ processor: 'made.up', params: {}, enabled: true }],
    });
    expect(() => stripSceneJson(1, strip, null)).not.toThrow();
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
    expect(engine.setTrackStripJson).toHaveBeenCalledTimes(1);
    expect(engine.setTrackStripJson).toHaveBeenCalledWith(1, stripSceneJson(1, track.mixer));
    expect(engine.setStripInsertBypassed).toHaveBeenCalledTimes(1);
    expect(engine.setStripInsertBypassed).toHaveBeenCalledWith(1, 1, true);

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

    expect(engine.setTrackStripJson).toHaveBeenCalledWith(
      1,
      stripSceneJson(1, makeStrip({ inputTrimDb: 6 })),
    );
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
    expect(engine.setTrackStripJson).not.toHaveBeenCalled();
    expect(engine.setStripInsertBypassed).toHaveBeenCalledTimes(1);
    expect(engine.setStripInsertBypassed).toHaveBeenCalledWith(1, 1, false);
  });

  it('re-sends the strip JSON, bypass flags and EQ bands on a param change', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const band: EqBand = { frequencyHz: 200, gainDb: 3, enabled: true };
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
    expect(engine.setTrackStripJson).toHaveBeenCalledTimes(1);
    expect(engine.setTrackStripJson).toHaveBeenCalledWith(1, stripSceneJson(1, next));
    expect(engine.setStripInsertBypassed).toHaveBeenCalledTimes(1);
    expect(engine.setStripInsertBypassed).toHaveBeenCalledWith(1, 1, true);
    expect(engine.setStripEq).toHaveBeenCalledTimes(1);
    expect(engine.setStripEq).toHaveBeenCalledWith(1, 0, band);
  });

  it('sends the strip JSON and every EQ band, then diffs band edits', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const bands: EqBand[] = [
      { frequencyHz: 120, gainDb: -2, enabled: true },
      { frequencyHz: 4000, gainDb: 4, enabled: true },
    ];

    sync.sync([makeTrack(1, makeStrip({ eq: { enabled: true, bands } }))], makeMixer());
    expect(engine.setTrackStripJson).toHaveBeenCalledTimes(1);
    expect(engine.setStripEq).toHaveBeenCalledTimes(2);
    expect(engine.setStripEq).toHaveBeenNthCalledWith(1, 1, 0, bands[0]);
    expect(engine.setStripEq).toHaveBeenNthCalledWith(2, 1, 1, bands[1]);
    clearCalls(engine);

    const edited: EqBand[] = [bands[0], { ...bands[1], gainDb: 6 }];
    sync.sync([makeTrack(1, makeStrip({ eq: { enabled: true, bands: edited } }))], makeMixer());
    expect(engine.setTrackStripJson).not.toHaveBeenCalled();
    expect(engine.setStripEq).toHaveBeenCalledTimes(1);
    expect(engine.setStripEq).toHaveBeenCalledWith(1, 1, edited[1]);
  });

  it('clears removed EQ bands with disabled bands instead of re-sending the strip', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const bands: EqBand[] = [
      { frequencyHz: 120, gainDb: -2, enabled: true },
      { frequencyHz: 4000, gainDb: 4, enabled: true },
    ];
    sync.sync([makeTrack(1, makeStrip({ eq: { enabled: true, bands } }))], makeMixer());
    clearCalls(engine);

    sync.sync([makeTrack(1, makeStrip())], makeMixer());
    expect(engine.setTrackStripJson).not.toHaveBeenCalled();
    expect(engine.setStripEq).toHaveBeenCalledTimes(2);
    expect(engine.setStripEq).toHaveBeenNthCalledWith(1, 1, 0, { enabled: false });
    expect(engine.setStripEq).toHaveBeenNthCalledWith(2, 1, 1, { enabled: false });
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

  it('routes the master strip through setMasterStripJson and the master target', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const band: EqBand = { frequencyHz: 8000, gainDb: -1, enabled: true };
    const master = makeStrip({
      inserts: [{ processor: 'saturation.tape', params: { drive: 0.2 }, enabled: false }],
      eq: { enabled: true, bands: [band] },
    });

    sync.sync([], makeMixer({ master }));
    expect(engine.setTrackStripJson).not.toHaveBeenCalled();
    expect(engine.setMasterStripJson).toHaveBeenCalledTimes(1);
    expect(engine.setMasterStripJson).toHaveBeenCalledWith(stripSceneJson('master', master));
    expect(engine.setStripInsertBypassed).toHaveBeenCalledWith('master', 0, true);
    expect(engine.setStripEq).toHaveBeenCalledWith('master', 0, band);
  });

  it('declares buses before sends, then adjusts gains and re-declares additions', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const track = makeTrack(1, makeStrip({ sends: [{ busId: 'A', levelDb: -12, enabled: true }] }));

    sync.sync([track], makeMixer({ buses: [makeBus('A')] }));
    expect(engine.setTrackBuses).toHaveBeenCalledTimes(1);
    expect(engine.setTrackBuses).toHaveBeenCalledWith([{ busId: 1, gainDb: 0 }]);
    expect(engine.setSends).toHaveBeenCalledTimes(1);
    expect(engine.setSends).toHaveBeenCalledWith(1, [{ busId: 1, levelDb: -12, enabled: true }]);
    expect(engine.setTrackBuses.mock.invocationCallOrder[0]).toBeLessThan(
      engine.setSends.mock.invocationCallOrder[0],
    );
    clearCalls(engine);

    // A gain change on an unchanged bus set adjusts in place.
    sync.sync([track], makeMixer({ buses: [makeBus('A', -3)] }));
    expect(engine.setTrackBuses).not.toHaveBeenCalled();
    expect(engine.setBusGain).toHaveBeenCalledTimes(1);
    expect(engine.setBusGain).toHaveBeenCalledWith(1, -3);
    clearCalls(engine);

    // Adding a bus re-declares the whole set.
    sync.sync([track], makeMixer({ buses: [makeBus('A', -3), makeBus('B')] }));
    expect(engine.setTrackBuses).toHaveBeenCalledTimes(1);
    expect(engine.setTrackBuses).toHaveBeenCalledWith([
      { busId: 1, gainDb: -3 },
      { busId: 2, gainDb: 0 },
    ]);
    expect(engine.setBusGain).not.toHaveBeenCalled();
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
    expect(engine.setSends).toHaveBeenCalledWith(1, [
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
    expect(engine.setSends).toHaveBeenCalledTimes(1);
    expect(engine.setSends).toHaveBeenCalledWith(1, [{ busId: 1, levelDb: -6, enabled: true }]);
  });

  it('prunes sends to a removed bus before re-declaring and never reuses its number', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const track = makeTrack(1, makeStrip({ sends: [{ busId: 'B', levelDb: -6, enabled: true }] }));

    sync.sync([track], makeMixer({ buses: [makeBus('A'), makeBus('B')] }));
    expect(engine.setSends).toHaveBeenCalledWith(1, [{ busId: 2, levelDb: -6, enabled: true }]);
    clearCalls(engine);

    // Removing the referenced bus prunes the send first, then re-declares.
    sync.sync([track], makeMixer({ buses: [makeBus('A')] }));
    expect(engine.setSends).toHaveBeenCalledTimes(1);
    expect(engine.setSends).toHaveBeenCalledWith(1, []);
    expect(engine.setTrackBuses).toHaveBeenCalledTimes(1);
    expect(engine.setTrackBuses).toHaveBeenCalledWith([{ busId: 1, gainDb: 0 }]);
    expect(engine.setSends.mock.invocationCallOrder[0]).toBeLessThan(
      engine.setTrackBuses.mock.invocationCallOrder[0],
    );
    clearCalls(engine);

    // A later bus gets a fresh number; the removed bus's number is not recycled.
    sync.sync([track], makeMixer({ buses: [makeBus('A'), makeBus('C')] }));
    expect(sync.busIdFor('A')).toBe(1);
    expect(sync.busIdFor('B')).toBe(2);
    expect(sync.busIdFor('C')).toBe(3);
    expect(sync.busIdFor('D')).toBeUndefined();
    expect(engine.setTrackBuses).toHaveBeenCalledWith([
      { busId: 1, gainDb: 0 },
      { busId: 3, gainDb: 0 },
    ]);
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
    expect(engine.setSends).toHaveBeenCalledTimes(1);
  });
});

describe('busSceneJson', () => {
  it('declares the bus with the submix role and stringified params', () => {
    const strip = makeStrip({
      inserts: [
        { processor: 'dynamics.compressor', params: { thresholdDb: -20 }, enabled: true },
        { processor: 'saturation.tape', params: { drive: 0.4 }, enabled: false },
      ],
    });
    expect(JSON.parse(busSceneJson(3, strip))).toEqual({
      version: 1,
      strips: [],
      buses: [
        {
          id: 'bus-3',
          role: 'submix',
          inserts: [
            { slot: 'pre', processor: 'dynamics.compressor', params: '{"thresholdDb":-20}' },
            { slot: 'pre', processor: 'saturation.tape', params: '{"drive":0.4}' },
          ],
        },
      ],
      connections: [],
    });
  });

  it('declares an empty bus strip for a missing strip', () => {
    expect(JSON.parse(busSceneJson(5, undefined))).toEqual({
      version: 1,
      strips: [],
      buses: [{ id: 'bus-5', role: 'submix', inserts: [] }],
      connections: [],
    });
  });

  it('rejects a processor not in the insert catalog, unless the catalog is null', () => {
    const strip = makeStrip({ inserts: [{ processor: 'made.up', params: {}, enabled: true }] });
    expect(() => busSceneJson(1, strip, new Set(['dynamics.compressor']))).toThrow(
      'Unsupported insert processor: made.up',
    );
    expect(() => busSceneJson(1, strip, null)).not.toThrow();
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

  it('keeps a group bus number stable when user buses are added later', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);

    sync.sync([makeGroupTrack(10)], makeMixer());
    expect(engine.setTrackBuses).toHaveBeenLastCalledWith([{ busId: 1, gainDb: 0 }]);

    sync.sync([makeGroupTrack(10)], makeMixer({ buses: [makeBus('A')] }));
    expect(engine.setTrackBuses).toHaveBeenLastCalledWith([
      { busId: 2, gainDb: 0 },
      { busId: 1, gainDb: 0 },
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
    expect(engine.setBusStripJson).toHaveBeenCalledTimes(1);
    expect(engine.setBusStripJson).toHaveBeenCalledWith(
      1,
      busSceneJson(1, makeStrip({ inserts: [inserts[0]] })),
    );
    clearCalls(engine);

    sync.sync([], makeMixer({ buses: [{ ...makeBus('FX'), strip: makeStrip() }] }));
    expect(engine.setBusStripJson).toHaveBeenCalledWith(1, busSceneJson(1, makeStrip()));
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
    expect(engine.setTrackOutputBus).toHaveBeenCalledWith(1, 0);
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

  it('sends only the enabled group inserts via the bus strip and re-sends on changes', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);
    const inserts = [
      { processor: 'dynamics.compressor', params: { thresholdDb: -20 }, enabled: true },
      { processor: 'saturation.tape', params: { drive: 0.4 }, enabled: false },
    ];

    sync.sync([makeGroupTrack(10, makeStrip({ inserts }))], makeMixer());
    expect(engine.setTrackStripJson).not.toHaveBeenCalled();
    expect(engine.setStripInsertBypassed).not.toHaveBeenCalled();
    expect(engine.setBusStripJson).toHaveBeenCalledTimes(1);
    expect(engine.setBusStripJson).toHaveBeenCalledWith(
      1,
      busSceneJson(1, makeStrip({ inserts: [inserts[0]] })),
    );
    clearCalls(engine);

    // Unchanged state stays silent.
    sync.sync([makeGroupTrack(10, makeStrip({ inserts }))], makeMixer());
    expect(totalCalls(engine)).toBe(0);

    // Enabling the second insert re-sends the whole (filtered) bus scene.
    const toggled = [inserts[0], { ...inserts[1], enabled: true }];
    sync.sync([makeGroupTrack(10, makeStrip({ inserts: toggled }))], makeMixer());
    expect(engine.setBusStripJson).toHaveBeenCalledTimes(1);
    expect(engine.setBusStripJson).toHaveBeenCalledWith(
      1,
      busSceneJson(1, makeStrip({ inserts: toggled })),
    );
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
    expect(engine.setBusStripJson).not.toHaveBeenCalled();
    expect(engine.setBusGain).toHaveBeenCalledTimes(1);
    const [busId, gainDb] = engine.setBusGain.mock.calls[0] as [number, number];
    expect(busId).toBe(1);
    expect(gainDb).toBeCloseTo(linearToDb(0.5), 6);
    clearCalls(engine);

    const muted = makeGroupTrack(10, makeStrip({ inserts }));
    muted.volume = 0.5;
    muted.mute = true;
    sync.sync([muted], makeMixer());
    expect(engine.setBusGain).toHaveBeenCalledTimes(1);
    expect(engine.setBusGain).toHaveBeenCalledWith(1, -120);
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
    expect(engine.setTrackOutputBus).toHaveBeenCalledWith(1, 0);
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
    expect(engine.setTrackOutputBus).toHaveBeenCalledWith(1, 0);
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
    expect(engine.setLaneSidechain).toHaveBeenCalledTimes(1);
    expect(engine.setLaneSidechain).toHaveBeenCalledWith(1, 0, 2);
    engine.setLaneSidechain.mockClear();

    // Unchanged binding stays silent.
    sync.sync([makeTrack(1, keyedStrip(2)), makeTrack(2), makeTrack(3)], makeMixer());
    expect(engine.setLaneSidechain).not.toHaveBeenCalled();

    // A source change rebinds directly, without an intermediate clear.
    sync.sync([makeTrack(1, keyedStrip(3)), makeTrack(2), makeTrack(3)], makeMixer());
    expect(engine.setLaneSidechain).toHaveBeenCalledTimes(1);
    expect(engine.setLaneSidechain).toHaveBeenCalledWith(1, 0, 3);
    engine.setLaneSidechain.mockClear();

    // Removing the binding clears the engine-side key with null.
    sync.sync([makeTrack(1, keyedStrip()), makeTrack(2), makeTrack(3)], makeMixer());
    expect(engine.setLaneSidechain).toHaveBeenCalledTimes(1);
    expect(engine.setLaneSidechain).toHaveBeenCalledWith(1, 0, null);
  });

  it('ignores self, unknown and group-track sidechain sources', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);

    sync.sync(
      [
        makeTrack(1, keyedStrip(1)),
        makeTrack(2, keyedStrip(99)),
        makeGroupTrack(10, keyedStrip(1)),
      ],
      makeMixer(),
    );
    expect(engine.setLaneSidechain).not.toHaveBeenCalled();
  });

  it('clears a binding whose source track disappears', () => {
    const { handle, engine } = makeHandle();
    const sync = createStripSync(handle);

    sync.sync([makeTrack(1, keyedStrip(2)), makeTrack(2)], makeMixer());
    engine.setLaneSidechain.mockClear();

    sync.sync([makeTrack(1, keyedStrip(2))], makeMixer());
    expect(engine.setLaneSidechain).toHaveBeenCalledTimes(1);
    expect(engine.setLaneSidechain).toHaveBeenCalledWith(1, 0, null);
  });
});
