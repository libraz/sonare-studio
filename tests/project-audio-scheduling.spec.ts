import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import type { LoadedAudioAsset } from '@/persistence/assets';
import {
  applyAudioClipFades,
  ppqToSeconds,
  resampleChannelsLinear,
  scheduleProjectClips,
  sliceAudioClipWindow,
} from '@/project/scheduling';
import { useProjectStore } from '@/project/store';
import type { EditorClip, EditorTrack } from '@/project/types';

/** Builds a track mirror entry with overridable fields. */
function makeTrack(id: number, overrides: Partial<EditorTrack> = {}): EditorTrack {
  return {
    id,
    name: `Track ${id}`,
    color: '#60a5fa',
    kind: 'audio',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: id,
    ...overrides,
  };
}

/** Builds an audio clip mirror entry with overridable fields. */
function makeAudioClip(
  id: number,
  trackId: number,
  overrides: Partial<EditorClip> = {},
): EditorClip {
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
    notes: [],
    kind: 'audio',
    assetId: 'asset-x',
    ...overrides,
  };
}

/** Builds a loaded-asset stub at 10 Hz so PPQ windows map to tiny frame counts. */
function makeAsset(frames: number, sampleRate = 10): LoadedAudioAsset {
  const channel = new Float32Array(frames);
  for (let i = 0; i < frames; i++) channel[i] = i + 1;
  return {
    meta: { id: 'asset-x', name: 'Asset', sampleRate, numChannels: 1, numFrames: frames },
    channels: [channel],
  };
}

/** EngineHandle stub capturing engine.addClip calls. */
function makeHandle(sampleRate = 10): {
  handle: EngineHandle;
  addClip: ReturnType<typeof vi.fn>;
} {
  const addClip = vi.fn(() => 500);
  const handle = {
    ctx: { sampleRate },
    engine: { addClip },
  } as unknown as EngineHandle;
  return { handle, addClip };
}

describe('audio scheduling helpers', () => {
  it('ppqToSeconds converts at a constant tempo', () => {
    expect(ppqToSeconds(2, 120)).toBe(1);
    expect(ppqToSeconds(1, 60)).toBe(1);
  });

  it('sliceAudioClipWindow cuts the source window in frames', () => {
    const channels = [new Float32Array([1, 2, 3, 4, 5, 6, 7, 8])];
    // At 120 BPM and 4 Hz: 1 PPQ = 0.5 s = 2 frames. Offset 1 PPQ, length 2 PPQ.
    const sliced = sliceAudioClipWindow(channels, 4, 1, 2, 120);
    expect(sliced).toEqual([new Float32Array([3, 4, 5, 6])]);
  });

  it('sliceAudioClipWindow clamps to the available frames', () => {
    const channels = [new Float32Array([1, 2, 3])];
    expect(sliceAudioClipWindow(channels, 4, 1, 4, 120)).toEqual([new Float32Array([3])]);
    expect(sliceAudioClipWindow(channels, 4, 10, 2, 120)).toEqual([new Float32Array(0)]);
  });

  it('applyAudioClipFades ramps the buffer edges linearly in place', () => {
    const channels = [new Float32Array([1, 1, 1, 1, 1, 1, 1, 1])];
    // At 120 BPM and 8 Hz: 1 PPQ = 0.5 s = 4 frames per fade.
    applyAudioClipFades(channels, 8, 120, 1, 1);
    expect(Array.from(channels[0])).toEqual([0, 0.25, 0.5, 0.75, 0.75, 0.5, 0.25, 0]);
  });

  it('applyAudioClipFades with zero fades leaves the buffer untouched', () => {
    const channels = [new Float32Array([1, 2, 3])];
    applyAudioClipFades(channels, 8, 120, 0, 0);
    expect(channels).toEqual([new Float32Array([1, 2, 3])]);
  });

  it('resampleChannelsLinear interpolates endpoint-preserving', () => {
    const channels = [new Float32Array([0, 3])];
    const out = resampleChannelsLinear(channels, 10, 20);
    expect(out).toEqual([new Float32Array([0, 1, 2, 3])]);
    // Same rate returns the input untouched.
    expect(resampleChannelsLinear(channels, 10, 10)).toBe(channels);
    expect(() => resampleChannelsLinear(channels, 0, 10)).toThrow(RangeError);
  });
});

describe('scheduleProjectClips with audio clips', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.tempoBpm = 120;
  });

  it('loads the asset and schedules the buffer at the clip start with the clip gain', async () => {
    store.tracks = [makeTrack(1, { volume: 0.5 })];
    // 4 PPQ at 120 BPM = 2 s = 20 frames at 10 Hz.
    store.clips = [makeAudioClip(10, 1, { startPpq: 8, gain: 0.8 })];
    const { handle, addClip } = makeHandle(10);
    const loadAudioAsset = vi.fn(async () => makeAsset(20));

    const scheduled = await scheduleProjectClips(handle, { loadAudioAsset });
    expect(scheduled).toEqual([{ engineClipId: 500, clipId: 10, trackId: 1 }]);
    expect(loadAudioAsset).toHaveBeenCalledWith('asset-x');
    expect(addClip).toHaveBeenCalledTimes(1);
    const [trackId, channels, startPpq, opts] = addClip.mock.calls[0];
    expect(trackId).toBe(1);
    expect(startPpq).toBe(8);
    // No loudness normalization, and track volume is engine lane state:
    // the scheduled gain is exactly the clip gain.
    expect(opts).toEqual({ gain: 0.8 });
    expect((channels as Float32Array[])[0]).toEqual(makeAsset(20).channels[0]);
  });

  it('slices the source window from sourceOffsetPpq and lengthPpq', async () => {
    store.tracks = [makeTrack(1)];
    // Offset 2 PPQ = 1 s = 10 frames; length 1 PPQ = 0.5 s = 5 frames.
    store.clips = [makeAudioClip(10, 1, { sourceOffsetPpq: 2, lengthPpq: 1 })];
    const { handle, addClip } = makeHandle(10);

    await scheduleProjectClips(handle, { loadAudioAsset: async () => makeAsset(20) });
    const channels = addClip.mock.calls[0][1] as Float32Array[];
    expect(channels[0]).toEqual(new Float32Array([11, 12, 13, 14, 15]));
  });

  it('bakes fades into the scheduled buffer edges', async () => {
    store.tracks = [makeTrack(1)];
    // Clip 2 PPQ = 1 s = 10 frames at 10 Hz; fades of 0.4 PPQ = 2 frames.
    store.clips = [makeAudioClip(10, 1, { lengthPpq: 2, fadeInPpq: 0.4, fadeOutPpq: 0.4 })];
    const { handle, addClip } = makeHandle(10);
    const asset: LoadedAudioAsset = {
      meta: { id: 'asset-x', name: 'A', sampleRate: 10, numChannels: 1, numFrames: 10 },
      channels: [new Float32Array(10).fill(1)],
    };

    await scheduleProjectClips(handle, { loadAudioAsset: async () => asset });
    const channels = addClip.mock.calls[0][1] as Float32Array[];
    expect(Array.from(channels[0])).toEqual([0, 0.5, 1, 1, 1, 1, 1, 1, 0.5, 0]);
    // The cached asset buffers stay untouched.
    expect(asset.channels[0]).toEqual(new Float32Array(10).fill(1));
  });

  it('resamples to the engine rate when the asset rate differs', async () => {
    store.tracks = [makeTrack(1)];
    store.clips = [makeAudioClip(10, 1, { lengthPpq: 2 })]; // 1 s at 120 BPM
    const { handle, addClip } = makeHandle(20); // engine at 20 Hz, asset at 10 Hz

    await scheduleProjectClips(handle, { loadAudioAsset: async () => makeAsset(10) });
    const channels = addClip.mock.calls[0][1] as Float32Array[];
    expect(channels[0].length).toBe(20);
    expect(channels[0][0]).toBeCloseTo(1, 5);
    expect(channels[0][19]).toBeCloseTo(10, 5);
  });

  it('schedules muted and soloed tracks alike (audibility is realtime mixer state)', async () => {
    store.tracks = [
      makeTrack(1, { solo: true }),
      makeTrack(2),
      makeTrack(3, { mute: true, solo: true }),
    ];
    store.clips = [makeAudioClip(10, 1), makeAudioClip(20, 2), makeAudioClip(30, 3)];
    const { handle } = makeHandle(10);

    const scheduled = await scheduleProjectClips(handle, {
      loadAudioAsset: async () => makeAsset(20),
    });
    expect(scheduled.map((s) => s.trackId)).toEqual([1, 2, 3]);
  });

  it('skips zero-gain clips, clips without assetId and missing assets', async () => {
    store.tracks = [makeTrack(1), makeTrack(2, { volume: 0 })];
    const orphan = makeAudioClip(11, 1);
    orphan.assetId = undefined;
    store.clips = [
      makeAudioClip(10, 1, { gain: 0 }),
      orphan,
      makeAudioClip(12, 1, { assetId: 'gone' }),
      makeAudioClip(20, 2),
    ];
    const { handle, addClip } = makeHandle(10);
    const loadAudioAsset = vi.fn(async (assetId: string) => {
      if (assetId === 'gone') throw new Error('missing');
      return makeAsset(20);
    });

    const scheduled = await scheduleProjectClips(handle, { loadAudioAsset });
    // Track volume is engine lane state: the volume-0 track still schedules.
    expect(scheduled).toEqual([{ engineClipId: 500, clipId: 20, trackId: 2 }]);
    expect(addClip).toHaveBeenCalledTimes(1);
    // Only clips with a positive gain and an asset id are attempted.
    expect(loadAudioAsset).toHaveBeenCalledTimes(2);
    expect(loadAudioAsset).toHaveBeenNthCalledWith(1, 'gone');
    expect(loadAudioAsset).toHaveBeenNthCalledWith(2, 'asset-x');
  });

  it('schedules only audio clips; MIDI clips are realtime engine state', async () => {
    store.tracks = [makeTrack(1), makeTrack(2, { kind: 'midi' })];
    const midiClip = makeAudioClip(20, 2, {
      notes: [{ id: 1, pitch: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0 }],
    });
    midiClip.kind = undefined; // a clip without kind is MIDI
    midiClip.assetId = undefined;
    store.clips = [makeAudioClip(10, 1), midiClip];
    const { handle, addClip } = makeHandle(10);

    const scheduled = await scheduleProjectClips(handle, {
      loadAudioAsset: async () => makeAsset(20),
    });
    // The MIDI clip produces no engine clip: it plays via the engine's MIDI
    // scheduling, not via addClip.
    expect(scheduled.map((s) => s.clipId)).toEqual([10]);
    expect(addClip).toHaveBeenCalledTimes(1);
  });

  it('uses the sampleRate option instead of the engine context rate', async () => {
    store.tracks = [makeTrack(1)];
    store.clips = [makeAudioClip(10, 1, { lengthPpq: 2 })];
    const { handle, addClip } = makeHandle(999); // ctx rate must be ignored

    await scheduleProjectClips(handle, {
      sampleRate: 10,
      loadAudioAsset: async () => makeAsset(10),
    });
    const channels = addClip.mock.calls[0][1] as Float32Array[];
    expect(channels[0].length).toBe(10); // no resampling happened
  });
});
