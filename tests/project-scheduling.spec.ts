import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import { scheduleMidiClip } from '@/engine/instruments';
import {
  clipPlaybackNotes,
  isTrackAudible,
  scheduleProjectClips,
  type TrackAudibilityState,
} from '@/project/scheduling';
import { useProjectStore } from '@/project/store';
import type { EditorClip, EditorNote, EditorTrack } from '@/project/types';

vi.mock('@/engine/instruments', () => ({
  scheduleMidiClip: vi.fn(async () => 0),
}));

const scheduleMidiClipMock = vi.mocked(scheduleMidiClip);

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

describe('isTrackAudible', () => {
  it('without any solo, only mute decides', () => {
    const tracks: TrackAudibilityState[] = [
      { mute: false, solo: false },
      { mute: true, solo: false },
    ];
    expect(isTrackAudible(tracks[0], tracks)).toBe(true);
    expect(isTrackAudible(tracks[1], tracks)).toBe(false);
  });

  it('with any solo active, only soloed tracks are audible', () => {
    const tracks: TrackAudibilityState[] = [
      { mute: false, solo: true },
      { mute: false, solo: false },
    ];
    expect(isTrackAudible(tracks[0], tracks)).toBe(true);
    expect(isTrackAudible(tracks[1], tracks)).toBe(false);
  });

  it('mute wins over the track’s own solo', () => {
    const tracks: TrackAudibilityState[] = [
      { mute: true, solo: true },
      { mute: false, solo: false },
    ];
    expect(isTrackAudible(tracks[0], tracks)).toBe(false);
    // The muted solo still counts as "a solo exists" for the others.
    expect(isTrackAudible(tracks[1], tracks)).toBe(false);
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
      { track: { mute: false, solo: true }, others: noSolo, audible: true },
      { track: { mute: false, solo: true }, others: someSolo, audible: true },
      { track: { mute: true, solo: false }, others: noSolo, audible: false },
      { track: { mute: true, solo: false }, others: someSolo, audible: false },
      { track: { mute: true, solo: true }, others: noSolo, audible: false },
      { track: { mute: true, solo: true }, others: someSolo, audible: false },
    ];
    for (const { track, others, audible } of cases) {
      expect(isTrackAudible(track, [track, ...others])).toBe(audible);
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
        { id: 2, pitch: 62, velocity: 90, startPpq: 2, durationPpq: 1, channel: 1 }, // window start
        { id: 3, pitch: 64, velocity: 80, startPpq: 5.5, durationPpq: 1, channel: 0 }, // inside
        { id: 4, pitch: 65, velocity: 70, startPpq: 6, durationPpq: 1, channel: 0 }, // at window end
      ],
    });
    expect(clipPlaybackNotes(clip)).toEqual([
      { note: 62, velocity: 90, startPpq: 0, durationPpq: 1, channel: 1 },
      { note: 64, velocity: 80, startPpq: 3.5, durationPpq: 1, channel: 0 },
    ]);
  });

  it('returns an empty list for an empty clip', () => {
    expect(clipPlaybackNotes(makeClip(1, 1, { notes: [] }))).toEqual([]);
  });
});

describe('scheduleProjectClips', () => {
  let store: ReturnType<typeof useProjectStore>;
  const handle = {} as EngineHandle;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useProjectStore();
    let nextEngineClipId = 100;
    scheduleMidiClipMock.mockReset();
    scheduleMidiClipMock.mockImplementation(async () => nextEngineClipId++);
  });

  it('schedules every clip of every audible track onto its engine track', async () => {
    store.tracks = [makeTrack(1), makeTrack(2)];
    store.clips = [makeClip(10, 1), makeClip(11, 1, { startPpq: 8 }), makeClip(20, 2)];
    store.tempoBpm = 100;

    const scheduled = await scheduleProjectClips(handle);
    expect(scheduled).toEqual([
      { engineClipId: 100, clipId: 10, trackId: 1 },
      { engineClipId: 101, clipId: 11, trackId: 1 },
      { engineClipId: 102, clipId: 20, trackId: 2 },
    ]);
    expect(scheduleMidiClipMock).toHaveBeenCalledTimes(3);

    const [h, trackId, notes, startPpq, options] = scheduleMidiClipMock.mock.calls[1];
    expect(h).toBe(handle);
    expect(trackId).toBe(1);
    expect(notes).toEqual([{ note: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0 }]);
    expect(startPpq).toBe(8);
    expect(options).toEqual({ tempoBpm: 100, targetPeak: 0.5 });
  });

  it('skips muted tracks and, when any track is soloed, all non-solo tracks', async () => {
    store.tracks = [
      makeTrack(1, { solo: true }),
      makeTrack(2),
      makeTrack(3, { mute: true }),
      makeTrack(4, { mute: true, solo: true }),
    ];
    store.clips = [makeClip(10, 1), makeClip(20, 2), makeClip(30, 3), makeClip(40, 4)];

    const scheduled = await scheduleProjectClips(handle);
    expect(scheduled.map((s) => s.trackId)).toEqual([1]);
  });

  it('plays all unmuted tracks when no solo is active', async () => {
    store.tracks = [makeTrack(1), makeTrack(2, { mute: true }), makeTrack(3)];
    store.clips = [makeClip(10, 1), makeClip(20, 2), makeClip(30, 3)];

    const scheduled = await scheduleProjectClips(handle);
    expect(scheduled.map((s) => s.trackId)).toEqual([1, 3]);
  });

  it('folds track volume and clip gain into the per-clip target peak', async () => {
    store.tracks = [makeTrack(1, { volume: 0.5 })];
    store.clips = [makeClip(10, 1, { gain: 0.8 })];

    await scheduleProjectClips(handle);
    const options = scheduleMidiClipMock.mock.calls[0][4];
    expect(options?.targetPeak).toBeCloseTo(0.5 * 0.5 * 0.8, 10);
  });

  it('skips empty clips and fully attenuated clips', async () => {
    store.tracks = [makeTrack(1), makeTrack(2, { volume: 0 })];
    store.clips = [makeClip(10, 1, { notes: [] }), makeClip(20, 2)];

    const scheduled = await scheduleProjectClips(handle);
    expect(scheduled).toEqual([]);
    expect(scheduleMidiClipMock).not.toHaveBeenCalled();
  });

  it('passes targetPeak null through unscaled (no volume/gain folding)', async () => {
    store.tracks = [makeTrack(1, { volume: 0 })];
    store.clips = [makeClip(10, 1, { gain: 0.5 })];

    const scheduled = await scheduleProjectClips(handle, { targetPeak: null });
    expect(scheduled).toHaveLength(1);
    expect(scheduleMidiClipMock.mock.calls[0][4]?.targetPeak).toBeNull();
  });

  it('forwards sampleRate, preset and tempo overrides', async () => {
    store.tracks = [makeTrack(1)];
    store.clips = [makeClip(10, 1)];
    store.tempoBpm = 100;

    await scheduleProjectClips(handle, { sampleRate: 44100, preset: 'saw-lead', tempoBpm: 90 });
    expect(scheduleMidiClipMock.mock.calls[0][4]).toEqual({
      sampleRate: 44100,
      preset: 'saw-lead',
      tempoBpm: 90,
      targetPeak: 0.5,
    });
  });

  it('handles the single-track degenerate case like the legacy flow', async () => {
    store.tracks = [makeTrack(1)];
    store.clips = [makeClip(10, 1)];

    const scheduled = await scheduleProjectClips(handle);
    expect(scheduled).toEqual([{ engineClipId: 100, clipId: 10, trackId: 1 }]);
    expect(scheduleMidiClipMock.mock.calls[0][1]).toBe(1);
  });
});
