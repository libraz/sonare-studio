import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import { scheduleMidiClip } from '@/engine/instruments';
import type { TrackInstrument } from '@/project/instrument';
import { createDefaultStrip, dbToLinear, type MixerStrip } from '@/project/mixer';
import type { StripProcessorDeps } from '@/project/mixer-dsp';
import { clearStripProcessingCache, scheduleProjectClips } from '@/project/scheduling';
import { useProjectStore } from '@/project/store';
import type { EditorClip, EditorNote, EditorTrack } from '@/project/types';

vi.mock('@/engine/instruments', async () => {
  const actual =
    await vi.importActual<typeof import('@/engine/instruments')>('@/engine/instruments');
  return { ...actual, scheduleMidiClip: vi.fn(async () => 0) };
});

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

/** Builds a one-note MIDI clip mirror entry with overridable fields. */
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

/** Builds an audio clip mirror entry referencing a stub asset. */
function makeAudioClip(
  id: number,
  trackId: number,
  overrides: Partial<EditorClip> = {},
): EditorClip {
  return makeClip(id, trackId, { kind: 'audio', assetId: `asset-${id}`, notes: [], ...overrides });
}

/** Stub asset loader: 8 stereo frames of 0.5 at 10 Hz (one frame per 0.05 ppq at 120 bpm). */
function makeAssetLoader(sampleRate = 10) {
  return vi.fn(async (assetId: string) => ({
    meta: { id: assetId, name: assetId, sampleRate, numChannels: 2, numFrames: 8 },
    channels: [new Float32Array(8).fill(0.5), new Float32Array(8).fill(0.5)],
  }));
}

/** EngineHandle stub capturing engine.addClip calls. */
function makeHandle(sampleRate = 10): { handle: EngineHandle; addClip: ReturnType<typeof vi.fn> } {
  const addClip = vi.fn(() => 500);
  const handle = {
    ctx: { sampleRate },
    engine: { addClip },
  } as unknown as EngineHandle;
  return { handle, addClip };
}

/** A strip with one enabled marker insert. */
function dspStrip(overrides: Partial<MixerStrip> = {}): MixerStrip {
  return {
    ...createDefaultStrip(),
    inserts: [{ processor: 'eq.tilt', params: { tiltDb: 2 }, enabled: true }],
    ...overrides,
  };
}

/** Pass-through-with-marker deps adding +0.25 per insert run. */
function markerDeps(): StripProcessorDeps & { processStereo: ReturnType<typeof vi.fn> } {
  return {
    processStereo: vi.fn((_name: string, left: Float32Array, right: Float32Array) => ({
      left: left.map((x) => x + 0.25),
      right: right.map((x) => x + 0.25),
    })),
  };
}

describe('scheduleProjectClips with mixer state', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useProjectStore();
    clearStripProcessingCache();
    let nextEngineClipId = 100;
    scheduleMidiClipMock.mockReset();
    scheduleMidiClipMock.mockImplementation(async () => nextEngineClipId++);
  });

  it('passes no mixer extras for neutral tracks (legacy options shape)', async () => {
    store.tracks = [makeTrack(1)];
    store.clips = [makeClip(10, 1)];
    store.tempoBpm = 100;
    const { handle } = makeHandle();

    await scheduleProjectClips(handle, { stripDsp: null });
    expect(scheduleMidiClipMock.mock.calls[0][4]).toEqual({ tempoBpm: 100, targetPeak: 0.5 });
  });

  it('forwards the track instrument to scheduleMidiClip', async () => {
    const instrument: TrackInstrument = { kind: 'synth-preset', preset: 'saw-lead' };
    store.tracks = [makeTrack(1, { instrument })];
    store.clips = [makeClip(10, 1)];
    const { handle } = makeHandle();

    await scheduleProjectClips(handle, { stripDsp: null });
    expect(scheduleMidiClipMock.mock.calls[0][4]?.instrument).toEqual(instrument);
  });

  it('folds strip gain and master gain into extraGain for MIDI clips', async () => {
    store.tracks = [makeTrack(1, { mixer: { ...createDefaultStrip(), gainDb: -6 } })];
    store.clips = [makeClip(10, 1)];
    store.mixer.master.gainDb = -6;
    const { handle } = makeHandle();

    await scheduleProjectClips(handle, { stripDsp: null });
    const options = scheduleMidiClipMock.mock.calls[0][4];
    expect(options?.extraGain).toBeCloseTo(dbToLinear(-6) * dbToLinear(-6), 10);
  });

  it('bakes strip pan plus master pan into the MIDI process hook', async () => {
    store.tracks = [makeTrack(1, { mixer: { ...createDefaultStrip(), pan: 0.5 } })];
    store.clips = [makeClip(10, 1)];
    store.mixer.master.pan = 0.25;
    const { handle } = makeHandle(48000);

    await scheduleProjectClips(handle, { stripDsp: null });
    const processChannels = scheduleMidiClipMock.mock.calls[0][4]?.processChannels;
    expect(processChannels).toBeTypeOf('function');
    const out = (processChannels as (c: Float32Array[]) => Float32Array[])([
      new Float32Array([1]),
      new Float32Array([1]),
    ]);
    // Combined pan 0.75 attenuates the left channel to 0.25.
    expect(out[0][0]).toBeCloseTo(0.25, 6);
    expect(out[1][0]).toBeCloseTo(1, 6);
  });

  it('applies strip DSP to audio clips and caches by strip identity', async () => {
    store.tracks = [makeTrack(1, { kind: 'audio', mixer: dspStrip() })];
    store.clips = [makeAudioClip(10, 1, { lengthPpq: 0.4 })];
    const deps = markerDeps();
    const { handle, addClip } = makeHandle(10);

    await scheduleProjectClips(handle, {
      stripDsp: deps,
      loadAudioAsset: makeAssetLoader(10),
    });
    expect(deps.processStereo).toHaveBeenCalledTimes(1);
    const channels = addClip.mock.calls[0][1] as Float32Array[];
    expect(channels[0][0]).toBeCloseTo(0.75, 6); // 0.5 + 0.25 marker

    // Re-scheduling the unchanged project hits the processed-buffer cache.
    await scheduleProjectClips(handle, {
      stripDsp: deps,
      loadAudioAsset: makeAssetLoader(10),
    });
    expect(deps.processStereo).toHaveBeenCalledTimes(1);
  });

  it('multiplies strip and master gain into the audio clip gain', async () => {
    store.tracks = [
      makeTrack(1, { kind: 'audio', volume: 0.5, mixer: { ...createDefaultStrip(), gainDb: 6 } }),
    ];
    store.clips = [makeAudioClip(10, 1, { gain: 0.8, lengthPpq: 0.4 })];
    const { handle, addClip } = makeHandle(10);

    await scheduleProjectClips(handle, { stripDsp: null, loadAudioAsset: makeAssetLoader(10) });
    const opts = addClip.mock.calls[0][3] as { gain: number };
    expect(opts.gain).toBeCloseTo(0.5 * 0.8 * dbToLinear(6), 10);
  });

  it('keeps the legacy audio gain exactly when the mixer is neutral', async () => {
    store.tracks = [makeTrack(1, { kind: 'audio', volume: 0.5 })];
    store.clips = [makeAudioClip(10, 1, { gain: 0.8, lengthPpq: 0.4 })];
    const { handle, addClip } = makeHandle(10);

    await scheduleProjectClips(handle, { loadAudioAsset: makeAssetLoader(10) });
    expect((addClip.mock.calls[0][3] as { gain: number }).gain).toBe(0.5 * 0.8);
  });

  it('bakes pan into scheduled audio buffers', async () => {
    store.tracks = [makeTrack(1, { kind: 'audio', mixer: { ...createDefaultStrip(), pan: -0.5 } })];
    store.clips = [makeAudioClip(10, 1, { lengthPpq: 0.4 })];
    const { handle, addClip } = makeHandle(10);

    await scheduleProjectClips(handle, { stripDsp: null, loadAudioAsset: makeAssetLoader(10) });
    const channels = addClip.mock.calls[0][1] as Float32Array[];
    expect(channels[0][0]).toBeCloseTo(0.5, 6);
    expect(channels[1][0]).toBeCloseTo(0.25, 6); // right attenuated by 1 + pan
  });

  it('legacy track.pan stays UI-only (buffers untouched)', async () => {
    store.tracks = [makeTrack(1, { kind: 'audio', pan: 1 })];
    store.clips = [makeAudioClip(10, 1, { lengthPpq: 0.4 })];
    const { handle, addClip } = makeHandle(10);

    await scheduleProjectClips(handle, { stripDsp: null, loadAudioAsset: makeAssetLoader(10) });
    const channels = addClip.mock.calls[0][1] as Float32Array[];
    expect(channels[0][0]).toBeCloseTo(0.5, 6);
    expect(channels[1][0]).toBeCloseTo(0.5, 6);
  });

  it('shares one processed render across reschedules for MIDI strips', async () => {
    store.tracks = [makeTrack(1, { mixer: dspStrip() })];
    store.clips = [makeClip(10, 1)];
    const deps = markerDeps();
    const { handle } = makeHandle(48000);

    await scheduleProjectClips(handle, { stripDsp: deps });
    const processChannels = scheduleMidiClipMock.mock.calls[0][4]?.processChannels as (
      c: Float32Array[],
    ) => Float32Array[];
    const render = [new Float32Array([0.5]), new Float32Array([0.5])];
    const first = processChannels(render);
    const second = processChannels(render);
    expect(deps.processStereo).toHaveBeenCalledTimes(1);
    expect(first[0][0]).toBeCloseTo(0.75, 6);
    expect(second).toBe(first);
    // The raw render is never mutated (the cache feeds the engine copies).
    expect(render[0][0]).toBeCloseTo(0.5, 6);
  });
});
