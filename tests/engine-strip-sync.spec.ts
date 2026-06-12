import { describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import { createStripSync, MAX_ENGINE_BUSES, stripSceneJson } from '@/engine/strip-sync';
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
      `Too many mixer buses for the engine: ${MAX_ENGINE_BUSES + 1} > ${MAX_ENGINE_BUSES}`,
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
