import { ErrorCode, SonareError } from '@libraz/libsonare';
import type { SonareEngine } from '@libraz/libsonare/worklet';
import { describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import { createMixerSync, linearToDb, PFL_AUDITION_GAIN_DB, SILENCE_DB } from '@/engine/mixer-sync';
import { createDefaultStrip, laneGainDb, type MixerStrip, vcaOffsetDb } from '@/project/mixer';
import type { EditorTrack } from '@/project/types';
import { fakeEngineHandle } from './fakes/engine';

/** Builds a track mirror entry with overridable fields. */
function makeTrack(id: number, overrides: Partial<EditorTrack> = {}): EditorTrack {
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
    ...overrides,
  };
}

/** The engine calls the mixer lane sync makes. */
type MixerLaneEngine = Pick<
  SonareEngine,
  | 'setTrackLanes'
  | 'setStripFaderDb'
  | 'setStripPan'
  | 'setTrackSoloMute'
  | 'setStripChannelDelaySamples'
  | 'setStripPanLaw'
  | 'setStripPanMode'
  | 'setStripDualPan'
>;

/** EngineHandle stub capturing the mixer-lane commands. */
function makeHandle(): {
  handle: EngineHandle;
  engine: {
    [K in keyof MixerLaneEngine]: ReturnType<typeof vi.fn>;
  };
} {
  // Enforces the engine's append-only lane contract, which a permissive stub
  // would let a redeclaration break unnoticed.
  const declared: number[] = [];
  const engine = {
    setTrackLanes: vi.fn((lanes: Array<{ trackId: number }>) => {
      if (declared.some((id, index) => lanes[index]?.trackId !== id)) {
        throw new Error('Mixer lanes are append-only');
      }
      declared.splice(0, declared.length, ...lanes.map((lane) => lane.trackId));
    }),
    setStripFaderDb: vi.fn(),
    setStripPan: vi.fn(),
    setTrackSoloMute: vi.fn(),
    setStripChannelDelaySamples: vi.fn(),
    setStripPanLaw: vi.fn(),
    setStripPanMode: vi.fn(),
    setStripDualPan: vi.fn(),
  } satisfies MixerLaneEngine;
  const handle = fakeEngineHandle({ engine, ctx: { state: 'running' } });
  return { handle, engine };
}

/** Neutral master strip for syncs that only exercise track lanes. */
function neutralMaster(): MixerStrip {
  return createDefaultStrip();
}

describe('linearToDb', () => {
  it('maps unity to 0 dB and halving to about -6 dB', () => {
    expect(linearToDb(1)).toBe(0);
    expect(linearToDb(0.5)).toBeCloseTo(-6.0206, 4);
  });

  it('maps zero (and below) to the silence floor', () => {
    expect(linearToDb(0)).toBe(SILENCE_DB);
    expect(linearToDb(-1)).toBe(SILENCE_DB);
  });
});

describe('createMixerSync', () => {
  it('declares the lanes in track order on the first sync', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    sync.sync([makeTrack(1), makeTrack(2)], neutralMaster());
    expect(engine.setTrackLanes).toHaveBeenCalledTimes(1);
    expect(engine.setTrackLanes).toHaveBeenCalledWith([{ trackId: 1 }, { trackId: 2 }]);
    expect(sync.laneTrackIds()).toEqual([1, 2]);
    expect(sync.sceneGeneration?.()).toBe(1);

    sync.sync([makeTrack(1), makeTrack(2)], neutralMaster());
    expect(sync.sceneGeneration?.()).toBe(1);
  });

  it('keeps existing lanes in place and appends new tracks', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    sync.sync([makeTrack(1), makeTrack(2)], neutralMaster());
    // A reordered list with a new track keeps the declared order and appends.
    sync.sync([makeTrack(3), makeTrack(2), makeTrack(1)], neutralMaster());
    expect(engine.setTrackLanes).toHaveBeenCalledTimes(2);
    expect(engine.setTrackLanes).toHaveBeenLastCalledWith([
      { trackId: 1 },
      { trackId: 2 },
      { trackId: 3 },
    ]);
    expect(sync.laneTrackIds()).toEqual([1, 2, 3]);
  });

  it('does not redeclare lanes when the track set is unchanged', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    sync.sync([makeTrack(1), makeTrack(2)], neutralMaster());
    sync.sync([makeTrack(1), makeTrack(2)], neutralMaster());
    expect(engine.setTrackLanes).toHaveBeenCalledTimes(1);
  });

  it('keeps a deleted track lane declared and mutes it', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    sync.sync([makeTrack(1), makeTrack(2, { solo: true })], neutralMaster());
    engine.setTrackLanes.mockClear();
    engine.setTrackSoloMute.mockClear();

    sync.sync([makeTrack(1)], neutralMaster());
    expect(sync.laneTrackIds()).toEqual([1, 2]);
    expect(engine.setTrackLanes).not.toHaveBeenCalled();
    expect(engine.setTrackSoloMute).toHaveBeenCalledWith(2, { solo: false, mute: true });

    // The retired lane is muted once, not on every sync.
    engine.setTrackSoloMute.mockClear();
    sync.sync([makeTrack(1)], neutralMaster());
    expect(engine.setTrackSoloMute).not.toHaveBeenCalled();
  });

  it('appends after a retired lane and mutes it again after the redeclaration', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    sync.sync([makeTrack(1), makeTrack(2)], neutralMaster());
    sync.sync([makeTrack(1)], neutralMaster());
    engine.setTrackSoloMute.mockClear();

    sync.sync([makeTrack(1), makeTrack(3)], neutralMaster());
    expect(engine.setTrackLanes).toHaveBeenLastCalledWith([
      { trackId: 1 },
      { trackId: 2 },
      { trackId: 3 },
    ]);
    expect(sync.laneTrackIds()).toEqual([1, 2, 3]);
    expect(engine.setTrackSoloMute).toHaveBeenCalledWith(2, { solo: false, mute: true });
  });

  it('restores an undeleted track on its original lane with its own state', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    sync.sync([makeTrack(1), makeTrack(2, { solo: true })], neutralMaster());
    sync.sync([makeTrack(1)], neutralMaster());
    engine.setTrackLanes.mockClear();
    engine.setTrackSoloMute.mockClear();

    sync.sync([makeTrack(1), makeTrack(2, { solo: true })], neutralMaster());
    expect(engine.setTrackLanes).not.toHaveBeenCalled();
    expect(sync.laneTrackIds()).toEqual([1, 2]);
    expect(engine.setTrackSoloMute).toHaveBeenCalledWith(2, { solo: true, mute: false });

    // Deleting it a second time mutes the lane again.
    engine.setTrackSoloMute.mockClear();
    sync.sync([makeTrack(1)], neutralMaster());
    expect(engine.setTrackSoloMute).toHaveBeenCalledWith(2, { solo: false, mute: true });
  });

  it('sends gain, pan and solo/mute per track on the first sync', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);
    const track = makeTrack(1, {
      volume: 0.5,
      solo: true,
      mute: false,
      mixer: { ...createDefaultStrip(), gainDb: -3, pan: 0.5 },
    });

    sync.sync([track], neutralMaster());
    expect(engine.setStripFaderDb).toHaveBeenCalledWith(1, linearToDb(0.5) - 3);
    expect(engine.setStripPan).toHaveBeenCalledWith(1, 0.5);
    expect(engine.setTrackSoloMute).toHaveBeenCalledWith(1, { solo: true, mute: false });
  });

  it('uses a safety-trimmed centered lane gain for PFL solo audition only', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);
    const soloed = makeTrack(1, {
      volume: 0.25,
      solo: true,
      mixer: { ...createDefaultStrip(), gainDb: -12, pan: 0.75 },
    });
    const soloSafe = makeTrack(2, {
      soloSafe: true,
      volume: 0.5,
      mixer: { ...createDefaultStrip(), gainDb: -6, pan: -0.5 },
    });

    sync.sync([soloed, soloSafe], neutralMaster(), undefined, undefined, 'pfl');

    expect(engine.setStripFaderDb).toHaveBeenCalledWith(1, PFL_AUDITION_GAIN_DB);
    expect(engine.setStripPan).toHaveBeenCalledWith(1, 0);
    expect(engine.setStripFaderDb).toHaveBeenCalledWith(2, linearToDb(0.5) - 6);
    expect(engine.setStripPan).toHaveBeenCalledWith(2, -0.5);
    expect(engine.setTrackSoloMute).toHaveBeenCalledWith(1, { solo: true, mute: false });
    expect(engine.setTrackSoloMute).toHaveBeenCalledWith(2, { solo: true, mute: false });
  });

  it('mirrors the channel alignment delay and resends only on change', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);
    const delayed = makeTrack(1, { mixer: { ...createDefaultStrip(), channelDelaySamples: 128 } });

    sync.sync([delayed, makeTrack(2)], neutralMaster());
    // Track 1 carries a delay; track 2 (neutral) does not need an initial no-op 0.
    expect(engine.setStripChannelDelaySamples).toHaveBeenCalledWith(1, 128);
    expect(engine.setStripChannelDelaySamples).not.toHaveBeenCalledWith(2, 0);
    engine.setStripChannelDelaySamples.mockClear();

    // An unchanged sync sends nothing.
    sync.sync([delayed, makeTrack(2)], neutralMaster());
    expect(engine.setStripChannelDelaySamples).not.toHaveBeenCalled();

    // Changing the delay (rounded to whole samples) resends only that track.
    sync.sync(
      [
        makeTrack(1, { mixer: { ...createDefaultStrip(), channelDelaySamples: 64.4 } }),
        makeTrack(2),
      ],
      neutralMaster(),
    );
    expect(engine.setStripChannelDelaySamples).toHaveBeenCalledTimes(1);
    expect(engine.setStripChannelDelaySamples).toHaveBeenCalledWith(1, 64);
  });

  it('adds automatic insert PDC to the manual channel delay', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle, {
      insertLatency: (slot) => (slot.processor === 'eq.linearPhase' ? 128 : 0),
    });
    const latent = makeTrack(1, {
      mixer: {
        ...createDefaultStrip(),
        inserts: [{ processor: 'eq.linearPhase', params: {}, enabled: true }],
      },
    });
    const dry = makeTrack(2);
    const manual = makeTrack(3, {
      mixer: { ...createDefaultStrip(), channelDelaySamples: 8 },
    });

    sync.sync([latent, dry, manual], neutralMaster());

    // Track 1 owns the max insert latency, so it needs no compensating delay.
    expect(engine.setStripChannelDelaySamples).not.toHaveBeenCalledWith(1, 0);
    expect(engine.setStripChannelDelaySamples).toHaveBeenCalledWith(2, 128);
    expect(engine.setStripChannelDelaySamples).toHaveBeenCalledWith(3, 136);
  });

  it('defers positive PDC until a strip scene has been declared', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle, {
      insertLatency: (slot) => (slot.processor === 'eq.linearPhase' ? 12 : 0),
      deferChannelDelay: true,
    });
    const latent = makeTrack(1, {
      mixer: {
        ...createDefaultStrip(),
        inserts: [{ processor: 'eq.linearPhase', params: {}, enabled: true }],
      },
    });
    sync.sync([latent, makeTrack(2)], neutralMaster());
    expect(sync.positiveChannelDelayTrackIds()).toEqual(new Set([2]));
    expect(engine.setStripChannelDelaySamples).not.toHaveBeenCalled();

    sync.applyChannelDelays(1);
    expect(engine.setStripChannelDelaySamples).toHaveBeenCalledWith(2, 12);
    engine.setStripChannelDelaySamples.mockClear();
    sync.sync([latent, makeTrack(2)], neutralMaster());
    sync.applyChannelDelays(1);
    expect(engine.setStripChannelDelaySamples).not.toHaveBeenCalled();
  });

  it('includes return-bus insert latency when synchronizing PDC', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle, {
      insertLatency: (slot) => (slot.processor === 'eq.linearPhase' ? 96 : 0),
    });
    const routed = makeTrack(1, {
      mixer: { ...createDefaultStrip(), outputBusId: 'return-fx' },
    });
    const dry = makeTrack(2);

    sync.sync([routed, dry], neutralMaster(), undefined, undefined, undefined, [
      {
        id: 'return-fx',
        strip: {
          ...createDefaultStrip(),
          inserts: [{ processor: 'eq.linearPhase', params: {}, enabled: true }],
        },
      },
    ]);

    expect(engine.setStripChannelDelaySamples).toHaveBeenCalledWith(2, 96);
  });

  it('mirrors pan law, pan mode and dual pan, resending only on change', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    // First sync skips neutral defaults; the engine already starts with these values.
    sync.sync([makeTrack(1)], neutralMaster());
    expect(engine.setStripPanLaw).not.toHaveBeenCalled();
    expect(engine.setStripPanMode).not.toHaveBeenCalled();
    expect(engine.setStripDualPan).not.toHaveBeenCalled();
    engine.setStripPanLaw.mockClear();
    engine.setStripPanMode.mockClear();
    engine.setStripDualPan.mockClear();

    // An unchanged sync sends nothing.
    sync.sync([makeTrack(1)], neutralMaster());
    expect(engine.setStripPanLaw).not.toHaveBeenCalled();
    expect(engine.setStripPanMode).not.toHaveBeenCalled();
    expect(engine.setStripDualPan).not.toHaveBeenCalled();

    // Switching mode and dual pan resends only those, with clamped positions.
    sync.sync(
      [
        makeTrack(1, {
          mixer: {
            ...createDefaultStrip(),
            panLaw: 'const6Db',
            panMode: 'dualPan',
            dualPan: { left: -2, right: 0.5 },
          },
        }),
      ],
      neutralMaster(),
    );
    expect(engine.setStripPanLaw).toHaveBeenCalledTimes(1);
    expect(engine.setStripPanLaw).toHaveBeenCalledWith(1, 'const6Db');
    expect(engine.setStripPanMode).toHaveBeenCalledTimes(1);
    expect(engine.setStripPanMode).toHaveBeenCalledWith(1, 'dualPan');
    expect(engine.setStripDualPan).toHaveBeenCalledTimes(1);
    expect(engine.setStripDualPan).toHaveBeenCalledWith(1, -1, 0.5);
  });

  it('preserves the neutral stereo dual-pan image when only the strip pan is set', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    sync.sync(
      [
        makeTrack(1, {
          mixer: {
            ...createDefaultStrip(),
            pan: 0.6,
            panMode: 'dualPan',
          },
        }),
      ],
      neutralMaster(),
    );

    expect(engine.setStripPan).toHaveBeenCalledWith(1, 0.6);
    expect(engine.setStripPanMode).toHaveBeenCalledWith(1, 'dualPan');
    expect(engine.setStripDualPan).not.toHaveBeenCalled();
  });

  it('uses legacy track pan without a strip and clamps strip pan', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    sync.sync(
      [makeTrack(1, { pan: -0.4 }), makeTrack(2, { mixer: { ...createDefaultStrip(), pan: 2 } })],
      neutralMaster(),
    );
    expect(engine.setStripFaderDb).toHaveBeenCalledWith(1, 0);
    expect(engine.setStripPan).toHaveBeenCalledWith(1, -0.4);
    expect(engine.setStripPan).toHaveBeenCalledWith(2, 1);
  });

  it('sends the silence floor for a track volume of 0', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    sync.sync([makeTrack(1, { volume: 0 })], neutralMaster());
    expect(engine.setStripFaderDb).toHaveBeenCalledWith(1, SILENCE_DB);
  });

  it('resends only the values that changed since the last sync', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    sync.sync([makeTrack(1)], neutralMaster());
    engine.setStripFaderDb.mockClear();
    engine.setStripPan.mockClear();
    engine.setTrackSoloMute.mockClear();

    // Unchanged state sends nothing.
    sync.sync([makeTrack(1)], neutralMaster());
    expect(engine.setStripFaderDb).not.toHaveBeenCalled();
    expect(engine.setStripPan).not.toHaveBeenCalled();
    expect(engine.setTrackSoloMute).not.toHaveBeenCalled();

    // A mute toggle sends only the solo/mute command.
    sync.sync([makeTrack(1, { mute: true })], neutralMaster());
    expect(engine.setStripFaderDb).not.toHaveBeenCalled();
    expect(engine.setStripPan).not.toHaveBeenCalled();
    expect(engine.setTrackSoloMute).toHaveBeenCalledTimes(1);
    expect(engine.setTrackSoloMute).toHaveBeenCalledWith(1, { solo: false, mute: true });

    // A volume change sends only the gain command.
    sync.sync([makeTrack(1, { mute: true, volume: 0.5 })], neutralMaster());
    expect(engine.setStripFaderDb).toHaveBeenCalledTimes(1);
    expect(engine.setStripFaderDb).toHaveBeenCalledWith(1, linearToDb(0.5));
    expect(engine.setStripPan).not.toHaveBeenCalled();
    expect(engine.setTrackSoloMute).toHaveBeenCalledTimes(1);
  });

  it('mirrors the master strip gain and clamped pan, deduped', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    sync.sync([], { ...createDefaultStrip(), gainDb: -6, pan: -2 });
    expect(engine.setStripFaderDb).toHaveBeenCalledWith('master', -6);
    expect(engine.setStripPan).toHaveBeenCalledWith('master', -1);
    engine.setStripFaderDb.mockClear();
    engine.setStripPan.mockClear();

    // Unchanged master sends nothing.
    sync.sync([], { ...createDefaultStrip(), gainDb: -6, pan: -2 });
    expect(engine.setStripFaderDb).not.toHaveBeenCalled();
    expect(engine.setStripPan).not.toHaveBeenCalled();

    // A pan change sends only the pan command.
    sync.sync([], { ...createDefaultStrip(), gainDb: -6, pan: 0.5 });
    expect(engine.setStripFaderDb).not.toHaveBeenCalled();
    expect(engine.setStripPan).toHaveBeenCalledTimes(1);
    expect(engine.setStripPan).toHaveBeenCalledWith('master', 0.5);
  });

  it('keeps a solo-safe track in the solo group while another track is soloed', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    // No solo active: the safe track is not forced into the solo group.
    sync.sync([makeTrack(1, { soloSafe: true }), makeTrack(2)], neutralMaster());
    expect(engine.setTrackSoloMute).toHaveBeenCalledWith(1, { solo: false, mute: false });
    engine.setTrackSoloMute.mockClear();

    // Track 2 soloed: the solo-safe track 1 joins the solo group (effSolo true).
    sync.sync([makeTrack(1, { soloSafe: true }), makeTrack(2, { solo: true })], neutralMaster());
    expect(engine.setTrackSoloMute).toHaveBeenCalledWith(1, { solo: true, mute: false });
    expect(engine.setTrackSoloMute).toHaveBeenCalledWith(2, { solo: true, mute: false });
  });

  it('expands a soloed group track to its member lanes in realtime sync', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    sync.sync(
      [makeTrack(1), makeTrack(2, { groupId: 3 }), makeTrack(3, { kind: 'group', solo: true })],
      neutralMaster(),
    );

    expect(engine.setTrackSoloMute).toHaveBeenCalledWith(1, { solo: false, mute: false });
    expect(engine.setTrackSoloMute).toHaveBeenCalledWith(2, { solo: true, mute: false });
    expect(engine.setTrackSoloMute).toHaveBeenCalledWith(3, { solo: true, mute: false });
  });

  it('folds the VCA group offset into a member track gain', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);
    const track = makeTrack(1, { vcaId: 'vca-1', mixer: { ...createDefaultStrip(), gainDb: -3 } });

    sync.sync([track], neutralMaster(), new Map([['vca-1', -6]]));
    expect(engine.setStripFaderDb).toHaveBeenCalledWith(1, -9);

    // Raising the VCA offset re-sends only the member gain.
    engine.setStripFaderDb.mockClear();
    sync.sync([track], neutralMaster(), new Map([['vca-1', 6]]));
    expect(engine.setStripFaderDb).toHaveBeenCalledTimes(1);
    expect(engine.setStripFaderDb).toHaveBeenCalledWith(1, 3);
  });

  it('folds VCA mute and solo into member lane state', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    sync.sync(
      [makeTrack(1, { vcaId: 'vca-1' }), makeTrack(2)],
      neutralMaster(),
      new Map([['vca-1', 0]]),
      new Map([['vca-1', { mute: true, solo: true }]]),
    );

    expect(engine.setTrackSoloMute).toHaveBeenCalledWith(1, { solo: true, mute: true });
    expect(engine.setTrackSoloMute).toHaveBeenCalledWith(2, { solo: false, mute: false });
  });

  it('leaves non-member tracks untouched by VCA offsets', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    sync.sync([makeTrack(1)], neutralMaster(), new Map([['vca-1', -6]]));
    expect(engine.setStripFaderDb).toHaveBeenCalledWith(1, 0);
  });

  it('sends a deleted lane nothing but its mute', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    sync.sync([makeTrack(1), makeTrack(2)], neutralMaster());
    engine.setStripFaderDb.mockClear();
    engine.setStripPan.mockClear();
    engine.setTrackSoloMute.mockClear();

    sync.sync([makeTrack(1, { volume: 0.5 })], neutralMaster());
    expect(engine.setStripFaderDb.mock.calls.map((call) => call[0])).not.toContain(2);
    expect(engine.setStripPan.mock.calls.map((call) => call[0])).not.toContain(2);
    expect(engine.setTrackSoloMute.mock.calls.filter((call) => call[0] === 2)).toEqual([
      [2, { solo: false, mute: true }],
    ]);
  });
});

describe('command ring refusals', () => {
  /** The error a full command ring raises. */
  const ringFull = () => new SonareError(ErrorCode.OutOfMemory, 'command ring full');

  /** Makes the ring setters accept only `budget` commands, then refuse. */
  function limitRing(engine: ReturnType<typeof makeHandle>['engine'], budget: { left: number }) {
    for (const setter of [engine.setStripFaderDb, engine.setStripPan, engine.setTrackSoloMute]) {
      setter.mockImplementation(() => {
        if (budget.left <= 0) throw ringFull();
        budget.left -= 1;
      });
    }
  }

  it('re-sends every refused lane value once the ring has room', () => {
    vi.useFakeTimers();
    try {
      const { handle, engine } = makeHandle();
      const budget = { left: 10 };
      limitRing(engine, budget);
      const sync = createMixerSync(handle);
      const tracks = Array.from({ length: 8 }, (_, i) =>
        makeTrack(i + 1, { volume: 0.5, pan: 0.25, mute: i % 2 === 0 }),
      );

      sync.sync(tracks, neutralMaster());
      budget.left = 1000;
      vi.advanceTimersByTime(200);

      for (const track of tracks) {
        const accepted = (mock: ReturnType<typeof vi.fn>) =>
          mock.mock.results.some(
            (result, i) => mock.mock.calls[i][0] === track.id && result.type === 'return',
          );
        expect(accepted(engine.setStripFaderDb)).toBe(true);
        expect(accepted(engine.setStripPan)).toBe(true);
        expect(accepted(engine.setTrackSoloMute)).toBe(true);
      }
      // Nothing is left pending, so no further re-sends are queued.
      const callsBefore = engine.setStripFaderDb.mock.calls.length;
      vi.advanceTimersByTime(500);
      expect(engine.setStripFaderDb.mock.calls.length).toBe(callsBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a refused value pending for the next sync even without a timer', () => {
    const { handle, engine } = makeHandle();
    engine.setStripFaderDb.mockImplementationOnce(() => {
      throw ringFull();
    });
    const sync = createMixerSync(handle);
    const tracks = [makeTrack(1, { volume: 0.5 })];

    sync.sync(tracks, neutralMaster());
    engine.setStripFaderDb.mockClear();
    sync.sync(tracks, neutralMaster());

    expect(engine.setStripFaderDb).toHaveBeenCalledTimes(1);
    expect(engine.setStripFaderDb).toHaveBeenCalledWith(1, linearToDb(0.5));
  });

  it('keeps a refused retired-lane mute pending', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);
    sync.sync([makeTrack(1), makeTrack(2)], neutralMaster());
    engine.setTrackSoloMute.mockClear();
    engine.setTrackSoloMute.mockImplementationOnce(() => {
      throw ringFull();
    });

    sync.sync([makeTrack(1)], neutralMaster());
    sync.sync([makeTrack(1)], neutralMaster());

    expect(engine.setTrackSoloMute.mock.calls.filter((call) => call[0] === 2)).toEqual([
      [2, { solo: false, mute: true }],
      [2, { solo: false, mute: true }],
    ]);
  });
});

describe('laneGainDb / vcaOffsetDb', () => {
  it('resolves a VCA group offset, defaulting unassigned and unknown ids to 0', () => {
    const groups = new Map([['vca-1', -6]]);
    expect(vcaOffsetDb('vca-1', groups)).toBe(-6);
    expect(vcaOffsetDb('missing', groups)).toBe(0);
    expect(vcaOffsetDb(undefined, groups)).toBe(0);
    expect(vcaOffsetDb('vca-1', undefined)).toBe(0);
  });

  it('combines volume, strip trim and VCA offset like the live lane fader', () => {
    expect(laneGainDb(1, undefined, 0)).toBeCloseTo(0, 9);
    expect(laneGainDb(1, -3, -6)).toBeCloseTo(-9, 9);
    // Matches mixer-sync's derivation for a VCA member: linearToDb(volume).
    expect(laneGainDb(0.5, 0, 0)).toBeCloseTo(linearToDb(0.5), 9);
  });
});
