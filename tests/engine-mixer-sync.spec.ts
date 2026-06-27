import { describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import { createMixerSync, linearToDb, SILENCE_DB } from '@/engine/mixer-sync';
import { createDefaultStrip, laneGainDb, type MixerStrip, vcaOffsetDb } from '@/project/mixer';
import type { EditorTrack } from '@/project/types';

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

/** EngineHandle stub capturing the mixer-lane commands. */
function makeHandle(): {
  handle: EngineHandle;
  engine: {
    setTrackLanes: ReturnType<typeof vi.fn>;
    setStripGain: ReturnType<typeof vi.fn>;
    setStripPan: ReturnType<typeof vi.fn>;
    setSoloMute: ReturnType<typeof vi.fn>;
    setTrackStripChannelDelaySamples: ReturnType<typeof vi.fn>;
    setTrackStripPanLaw: ReturnType<typeof vi.fn>;
    setTrackStripPanMode: ReturnType<typeof vi.fn>;
    setTrackStripDualPan: ReturnType<typeof vi.fn>;
  };
} {
  const engine = {
    setTrackLanes: vi.fn(),
    setStripGain: vi.fn(),
    setStripPan: vi.fn(),
    setSoloMute: vi.fn(),
    setTrackStripChannelDelaySamples: vi.fn(),
    setTrackStripPanLaw: vi.fn(),
    setTrackStripPanMode: vi.fn(),
    setTrackStripDualPan: vi.fn(),
  };
  const handle = { engine } as unknown as EngineHandle;
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
    expect(engine.setTrackLanes).toHaveBeenCalledWith([1, 2]);
    expect(sync.laneTrackIds()).toEqual([1, 2]);
  });

  it('keeps existing lanes in place and appends new tracks', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    sync.sync([makeTrack(1), makeTrack(2)], neutralMaster());
    // A reordered list with a new track keeps the declared order and appends.
    sync.sync([makeTrack(3), makeTrack(2), makeTrack(1)], neutralMaster());
    expect(engine.setTrackLanes).toHaveBeenCalledTimes(2);
    expect(engine.setTrackLanes).toHaveBeenLastCalledWith([1, 2, 3]);
    expect(sync.laneTrackIds()).toEqual([1, 2, 3]);
  });

  it('does not redeclare lanes when the track set is unchanged', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    sync.sync([makeTrack(1), makeTrack(2)], neutralMaster());
    sync.sync([makeTrack(1), makeTrack(2)], neutralMaster());
    expect(engine.setTrackLanes).toHaveBeenCalledTimes(1);
  });

  it('mutes a deleted track lane once and keeps it in the registry', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    // Track 2 is soloed, then removed: its lane must fall silent so the stale
    // solo cannot duck the surviving track.
    sync.sync([makeTrack(1), makeTrack(2, { solo: true })], neutralMaster());
    engine.setSoloMute.mockClear();

    sync.sync([makeTrack(1)], neutralMaster());
    expect(engine.setSoloMute).toHaveBeenCalledWith(2, false, true);
    // The lane index is retained (append-only contract).
    expect(sync.laneTrackIds()).toEqual([1, 2]);

    // A subsequent unchanged sync does not re-issue the mute.
    engine.setSoloMute.mockClear();
    sync.sync([makeTrack(1)], neutralMaster());
    expect(engine.setSoloMute).not.toHaveBeenCalledWith(2, false, true);
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
    expect(engine.setStripGain).toHaveBeenCalledWith(1, linearToDb(0.5) - 3);
    expect(engine.setStripPan).toHaveBeenCalledWith(1, 0.5);
    expect(engine.setSoloMute).toHaveBeenCalledWith(1, true, false);
  });

  it('mirrors the channel alignment delay and resends only on change', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);
    const delayed = makeTrack(1, { mixer: { ...createDefaultStrip(), channelDelaySamples: 128 } });

    sync.sync([delayed, makeTrack(2)], neutralMaster());
    // Track 1 carries a delay; track 2 (neutral) is sent 0 once.
    expect(engine.setTrackStripChannelDelaySamples).toHaveBeenCalledWith(1, 128);
    expect(engine.setTrackStripChannelDelaySamples).toHaveBeenCalledWith(2, 0);
    engine.setTrackStripChannelDelaySamples.mockClear();

    // An unchanged sync sends nothing.
    sync.sync([delayed, makeTrack(2)], neutralMaster());
    expect(engine.setTrackStripChannelDelaySamples).not.toHaveBeenCalled();

    // Changing the delay (rounded to whole samples) resends only that track.
    sync.sync(
      [
        makeTrack(1, { mixer: { ...createDefaultStrip(), channelDelaySamples: 64.4 } }),
        makeTrack(2),
      ],
      neutralMaster(),
    );
    expect(engine.setTrackStripChannelDelaySamples).toHaveBeenCalledTimes(1);
    expect(engine.setTrackStripChannelDelaySamples).toHaveBeenCalledWith(1, 64);
  });

  it('mirrors pan law, pan mode and dual pan, resending only on change', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    // First sync sets the defaults (pan law -3 dB, balance) and the derived
    // dual pan (both channels at the strip pan position, here 0).
    sync.sync([makeTrack(1)], neutralMaster());
    expect(engine.setTrackStripPanLaw).toHaveBeenCalledWith(1, 'const3dB');
    expect(engine.setTrackStripPanMode).toHaveBeenCalledWith(1, 'balance');
    expect(engine.setTrackStripDualPan).toHaveBeenCalledWith(1, 0, 0);
    engine.setTrackStripPanLaw.mockClear();
    engine.setTrackStripPanMode.mockClear();
    engine.setTrackStripDualPan.mockClear();

    // An unchanged sync sends nothing.
    sync.sync([makeTrack(1)], neutralMaster());
    expect(engine.setTrackStripPanLaw).not.toHaveBeenCalled();
    expect(engine.setTrackStripPanMode).not.toHaveBeenCalled();
    expect(engine.setTrackStripDualPan).not.toHaveBeenCalled();

    // Switching mode and dual pan resends only those, with clamped positions.
    sync.sync(
      [
        makeTrack(1, {
          mixer: {
            ...createDefaultStrip(),
            panLaw: 'const6dB',
            panMode: 'dualPan',
            dualPan: { left: -1, right: 2 },
          },
        }),
      ],
      neutralMaster(),
    );
    expect(engine.setTrackStripPanLaw).toHaveBeenCalledTimes(1);
    expect(engine.setTrackStripPanLaw).toHaveBeenCalledWith(1, 'const6dB');
    expect(engine.setTrackStripPanMode).toHaveBeenCalledTimes(1);
    expect(engine.setTrackStripPanMode).toHaveBeenCalledWith(1, 'dualPan');
    expect(engine.setTrackStripDualPan).toHaveBeenCalledTimes(1);
    expect(engine.setTrackStripDualPan).toHaveBeenCalledWith(1, -1, 1);
  });

  it('treats a missing strip as neutral and clamps the strip pan', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    sync.sync(
      [makeTrack(1), makeTrack(2, { mixer: { ...createDefaultStrip(), pan: 2 } })],
      neutralMaster(),
    );
    expect(engine.setStripGain).toHaveBeenCalledWith(1, 0);
    expect(engine.setStripPan).toHaveBeenCalledWith(1, 0);
    expect(engine.setStripPan).toHaveBeenCalledWith(2, 1);
  });

  it('sends the silence floor for a track volume of 0', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    sync.sync([makeTrack(1, { volume: 0 })], neutralMaster());
    expect(engine.setStripGain).toHaveBeenCalledWith(1, SILENCE_DB);
  });

  it('resends only the values that changed since the last sync', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    sync.sync([makeTrack(1)], neutralMaster());
    engine.setStripGain.mockClear();
    engine.setStripPan.mockClear();
    engine.setSoloMute.mockClear();

    // Unchanged state sends nothing.
    sync.sync([makeTrack(1)], neutralMaster());
    expect(engine.setStripGain).not.toHaveBeenCalled();
    expect(engine.setStripPan).not.toHaveBeenCalled();
    expect(engine.setSoloMute).not.toHaveBeenCalled();

    // A mute toggle sends only the solo/mute command.
    sync.sync([makeTrack(1, { mute: true })], neutralMaster());
    expect(engine.setStripGain).not.toHaveBeenCalled();
    expect(engine.setStripPan).not.toHaveBeenCalled();
    expect(engine.setSoloMute).toHaveBeenCalledTimes(1);
    expect(engine.setSoloMute).toHaveBeenCalledWith(1, false, true);

    // A volume change sends only the gain command.
    sync.sync([makeTrack(1, { mute: true, volume: 0.5 })], neutralMaster());
    expect(engine.setStripGain).toHaveBeenCalledTimes(1);
    expect(engine.setStripGain).toHaveBeenCalledWith(1, linearToDb(0.5));
    expect(engine.setStripPan).not.toHaveBeenCalled();
    expect(engine.setSoloMute).toHaveBeenCalledTimes(1);
  });

  it('mirrors the master strip gain and clamped pan, deduped', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    sync.sync([], { ...createDefaultStrip(), gainDb: -6, pan: -2 });
    expect(engine.setStripGain).toHaveBeenCalledWith('master', -6);
    expect(engine.setStripPan).toHaveBeenCalledWith('master', -1);
    engine.setStripGain.mockClear();
    engine.setStripPan.mockClear();

    // Unchanged master sends nothing.
    sync.sync([], { ...createDefaultStrip(), gainDb: -6, pan: -2 });
    expect(engine.setStripGain).not.toHaveBeenCalled();
    expect(engine.setStripPan).not.toHaveBeenCalled();

    // A pan change sends only the pan command.
    sync.sync([], { ...createDefaultStrip(), gainDb: -6, pan: 0.5 });
    expect(engine.setStripGain).not.toHaveBeenCalled();
    expect(engine.setStripPan).toHaveBeenCalledTimes(1);
    expect(engine.setStripPan).toHaveBeenCalledWith('master', 0.5);
  });

  it('keeps a solo-safe track in the solo group while another track is soloed', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    // No solo active: the safe track is not forced into the solo group.
    sync.sync([makeTrack(1, { soloSafe: true }), makeTrack(2)], neutralMaster());
    expect(engine.setSoloMute).toHaveBeenCalledWith(1, false, false);
    engine.setSoloMute.mockClear();

    // Track 2 soloed: the solo-safe track 1 joins the solo group (effSolo true).
    sync.sync([makeTrack(1, { soloSafe: true }), makeTrack(2, { solo: true })], neutralMaster());
    expect(engine.setSoloMute).toHaveBeenCalledWith(1, true, false);
    expect(engine.setSoloMute).toHaveBeenCalledWith(2, true, false);
  });

  it('folds the VCA group offset into a member track gain', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);
    const track = makeTrack(1, { vcaId: 'vca-1', mixer: { ...createDefaultStrip(), gainDb: -3 } });

    sync.sync([track], neutralMaster(), new Map([['vca-1', -6]]));
    expect(engine.setStripGain).toHaveBeenCalledWith(1, -9);

    // Raising the VCA offset re-sends only the member gain.
    engine.setStripGain.mockClear();
    sync.sync([track], neutralMaster(), new Map([['vca-1', 6]]));
    expect(engine.setStripGain).toHaveBeenCalledTimes(1);
    expect(engine.setStripGain).toHaveBeenCalledWith(1, 3);
  });

  it('leaves non-member tracks untouched by VCA offsets', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    sync.sync([makeTrack(1)], neutralMaster(), new Map([['vca-1', -6]]));
    expect(engine.setStripGain).toHaveBeenCalledWith(1, 0);
  });

  it('keeps the lane of a removed track, redeclaring nothing but muting it', () => {
    const { handle, engine } = makeHandle();
    const sync = createMixerSync(handle);

    sync.sync([makeTrack(1), makeTrack(2)], neutralMaster());
    engine.setTrackLanes.mockClear();
    engine.setStripGain.mockClear();
    engine.setStripPan.mockClear();
    engine.setSoloMute.mockClear();

    sync.sync([makeTrack(1)], neutralMaster());
    expect(sync.laneTrackIds()).toEqual([1, 2]);
    expect(engine.setTrackLanes).not.toHaveBeenCalled();
    // The removed lane gets only a one-time silencing mute, no level changes.
    expect(engine.setStripGain.mock.calls.map((call) => call[0])).not.toContain(2);
    expect(engine.setStripPan.mock.calls.map((call) => call[0])).not.toContain(2);
    expect(engine.setSoloMute).toHaveBeenCalledWith(2, false, true);
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
