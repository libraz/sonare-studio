import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import type { LoadedAudioAsset } from '@/persistence/assets';
import {
  clipPlaybackNotes,
  scheduleProjectClips,
  type TrackAudibilityState,
  trackAudibilityStates,
} from '@/project/scheduling';
import { useProjectStore } from '@/project/store';
import type { EditorClip, EditorNote, EditorTrack } from '@/project/types';

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

/** Builds a one-note clip mirror entry with overridable fields. */
function makeClip(id: number, trackId: number, overrides: Partial<EditorClip> = {}): EditorClip {
  const notes: EditorNote[] = [
    { id: id * 100, pitch: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0 },
  ];
  return {
    id,
    trackId,
    name: `Clip ${id}`,
    startPpq: 0,
    lengthPpq: 4,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes,
    ...overrides,
  };
}

describe('trackAudibilityStates', () => {
  it('without any solo, only mute decides', () => {
    const tracks: TrackAudibilityState[] = [
      { mute: false, solo: false },
      { mute: true, solo: false },
    ];
    expect(trackAudibilityStates(tracks)[0]).toBe(true);
    expect(trackAudibilityStates(tracks)[1]).toBe(false);
  });

  it('with any solo active, only soloed and solo-safe tracks are audible', () => {
    const tracks: TrackAudibilityState[] = [
      { mute: false, solo: true },
      { mute: false, solo: false },
      { mute: false, solo: false, soloSafe: true },
    ];
    expect(trackAudibilityStates(tracks)[0]).toBe(true);
    expect(trackAudibilityStates(tracks)[1]).toBe(false);
    expect(trackAudibilityStates(tracks)[2]).toBe(true);
  });

  it('expands a soloed group to its routed members', () => {
    const tracks = [
      { mute: false, solo: false },
      { mute: false, solo: false, groupIndex: 2 },
      { mute: false, solo: true, kind: 'group' },
      { mute: false, solo: false },
    ];
    const options = {
      isGroup: (track: (typeof tracks)[number]) => track.kind === 'group',
      groupKey: (_track: (typeof tracks)[number], index: number) => index,
      memberGroupKey: (track: (typeof tracks)[number]) => track.groupIndex,
    };

    expect(trackAudibilityStates(tracks, options)[0]).toBe(false);
    expect(trackAudibilityStates(tracks, options)[1]).toBe(true);
    expect(trackAudibilityStates(tracks, options)[2]).toBe(true);
    const mutedTracks = [tracks[2], { ...tracks[1], mute: true }];
    expect(trackAudibilityStates(mutedTracks, options)[1]).toBe(false);
  });

  it('mute wins over the track’s own solo and solo-safe state', () => {
    const tracks: TrackAudibilityState[] = [
      { mute: true, solo: true },
      { mute: true, solo: false, soloSafe: true },
      { mute: false, solo: false },
    ];
    expect(trackAudibilityStates(tracks)[0]).toBe(false);
    expect(trackAudibilityStates(tracks)[1]).toBe(false);
    // The muted solo still counts as "a solo exists" for the others.
    expect(trackAudibilityStates(tracks)[2]).toBe(false);
  });

  it('covers the full mute x solo x any-solo matrix', () => {
    const someSolo: TrackAudibilityState[] = [{ mute: false, solo: true }];
    const noSolo: TrackAudibilityState[] = [{ mute: false, solo: false }];
    const cases: Array<{
      track: TrackAudibilityState;
      others: TrackAudibilityState[];
      audible: boolean;
    }> = [
      { track: { mute: false, solo: false }, others: noSolo, audible: true },
      { track: { mute: false, solo: false }, others: someSolo, audible: false },
      { track: { mute: false, solo: false, soloSafe: true }, others: noSolo, audible: true },
      { track: { mute: false, solo: false, soloSafe: true }, others: someSolo, audible: true },
      { track: { mute: false, solo: true }, others: noSolo, audible: true },
      { track: { mute: false, solo: true }, others: someSolo, audible: true },
      { track: { mute: true, solo: false }, others: noSolo, audible: false },
      { track: { mute: true, solo: false }, others: someSolo, audible: false },
      { track: { mute: true, solo: false, soloSafe: true }, others: noSolo, audible: false },
      { track: { mute: true, solo: false, soloSafe: true }, others: someSolo, audible: false },
      { track: { mute: true, solo: true }, others: noSolo, audible: false },
      { track: { mute: true, solo: true }, others: someSolo, audible: false },
    ];
    for (const { track, others, audible } of cases) {
      expect(trackAudibilityStates([track, ...others])[0]).toBe(audible);
    }
  });
});

describe('clipPlaybackNotes', () => {
  it('selects the clip window in source coordinates and shifts it to zero', () => {
    const clip = makeClip(1, 1, {
      sourceOffsetPpq: 2,
      lengthPpq: 4,
      notes: [
        { id: 1, pitch: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0 }, // before window
        {
          id: 2,
          pitch: 62,
          velocity: 90,
          offVelocity: 30,
          startPpq: 2,
          durationPpq: 1,
          channel: 1,
        }, // window start
        { id: 5, pitch: 61, velocity: 85, startPpq: 1.5, durationPpq: 1, channel: 0 }, // overlaps start
        { id: 3, pitch: 64, velocity: 80, startPpq: 5.5, durationPpq: 1, channel: 0 }, // inside
        { id: 4, pitch: 65, velocity: 70, startPpq: 6, durationPpq: 1, channel: 0 }, // at window end
      ],
    });
    expect(clipPlaybackNotes(clip)).toEqual([
      { note: 62, velocity: 90, offVelocity: 30, startPpq: 0, durationPpq: 1, channel: 1 },
      { note: 61, velocity: 85, startPpq: 0, durationPpq: 0.5, channel: 0 },
      { note: 64, velocity: 80, startPpq: 3.5, durationPpq: 0.5, channel: 0 },
    ]);
  });

  it('returns an empty list for an empty clip', () => {
    expect(clipPlaybackNotes(makeClip(1, 1, { notes: [] }))).toEqual([]);
  });
});

/** Builds an audio clip mirror entry referencing a stub asset. */
function makeAudioClip(
  id: number,
  trackId: number,
  overrides: Partial<EditorClip> = {},
): EditorClip {
  return makeClip(id, trackId, { kind: 'audio', assetId: 'asset-x', notes: [], ...overrides });
}

/** Loaded-asset stub: 20 mono frames at 10 Hz (4 PPQ at 120 BPM = 2 s). */
function makeAsset(): LoadedAudioAsset {
  return {
    meta: { id: 'asset-x', name: 'Asset', sampleRate: 10, numChannels: 1, numFrames: 20 },
    channels: [new Float32Array(20).fill(0.5)],
  };
}

/** EngineHandle stub capturing engine.addClip calls. */
function makeHandle(): { handle: EngineHandle; addClip: ReturnType<typeof vi.fn> } {
  const addClip = vi.fn(() => 500);
  const handle = {
    ctx: { sampleRate: 10 },
    engine: { addClip, setWarpVoiceCapacity: vi.fn() },
  } as unknown as EngineHandle;
  return { handle, addClip };
}

describe('scheduleProjectClips', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.tempoBpm = 120;
  });

  it('does not schedule MIDI clips (MIDI playback is realtime engine state)', async () => {
    store.tracks = [makeTrack(1), makeTrack(2)];
    store.clips = [makeClip(10, 1), makeClip(11, 1, { startPpq: 8 }), makeClip(20, 2)];
    const { handle, addClip } = makeHandle();

    const scheduled = await scheduleProjectClips(handle);
    expect(scheduled).toEqual([]);
    expect(addClip).not.toHaveBeenCalled();
  });

  it('still schedules audio clips while skipping MIDI clips on the same tracks', async () => {
    store.tracks = [makeTrack(1), makeTrack(2, { kind: 'audio' })];
    store.clips = [makeClip(10, 1), makeAudioClip(20, 2, { startPpq: 4, gain: 0.8 })];
    const { handle, addClip } = makeHandle();

    const scheduled = await scheduleProjectClips(handle, {
      loadAudioAsset: async () => makeAsset(),
    });
    expect(scheduled).toEqual([{ engineClipId: 500, clipId: 20, trackId: 2 }]);
    expect(addClip).toHaveBeenCalledTimes(1);
    const [trackId, { startPpq, ...opts }] = addClip.mock.calls[0];
    expect(trackId).toBe(2);
    expect(startPpq).toBe(4);
    expect(opts).toMatchObject({ gain: 0.8 });
  });

  it('skips MIDI clips regardless of mute/solo state', async () => {
    store.tracks = [
      makeTrack(1, { solo: true }),
      makeTrack(2),
      makeTrack(3, { mute: true }),
      makeTrack(4, { mute: true, solo: true }),
    ];
    store.clips = [makeClip(10, 1), makeClip(20, 2), makeClip(30, 3), makeClip(40, 4)];
    const { handle, addClip } = makeHandle();

    const scheduled = await scheduleProjectClips(handle);
    expect(scheduled).toEqual([]);
    expect(addClip).not.toHaveBeenCalled();
  });
});
