import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import type { TrackInstrument } from '@/project/instrument';
import { createDefaultStrip, type MixerStrip } from '@/project/mixer';
import { scheduleProjectClips } from '@/project/scheduling';
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

/** A strip with one enabled insert (realtime engine state, not baked here). */
function dspStrip(overrides: Partial<MixerStrip> = {}): MixerStrip {
  return {
    ...createDefaultStrip(),
    inserts: [{ processor: 'eq.tilt', params: { tiltDb: 2 }, enabled: true }],
    ...overrides,
  };
}

describe('scheduleProjectClips with mixer state', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useProjectStore();
  });

  it('does not schedule MIDI clips regardless of instrument and mixer state', async () => {
    const instrument: TrackInstrument = { kind: 'synth-preset', preset: 'saw-lead' };
    store.tracks = [makeTrack(1, { instrument }), makeTrack(2, { mixer: dspStrip({ pan: 0.5 }) })];
    store.clips = [makeClip(10, 1), makeClip(20, 2)];
    store.mixer.master.gainDb = -6;
    const { handle, addClip } = makeHandle();

    // MIDI clips and instruments are realtime engine state: nothing is
    // bounced or placed on the engine timeline here.
    const scheduled = await scheduleProjectClips(handle);
    expect(scheduled).toEqual([]);
    expect(addClip).not.toHaveBeenCalled();
  });

  it('schedules audio clips raw even when the strip carries insert DSP', async () => {
    store.tracks = [makeTrack(1, { kind: 'audio', mixer: dspStrip() })];
    store.clips = [makeAudioClip(10, 1, { lengthPpq: 0.4 })];
    const { handle, addClip } = makeHandle(10);

    await scheduleProjectClips(handle, { loadAudioAsset: makeAssetLoader(10) });
    const channels = addClip.mock.calls[0][1] as Float32Array[];
    // The insert chain is realtime engine state: the buffer stays unprocessed.
    expect(channels[0][0]).toBeCloseTo(0.5, 6);
    expect(channels[1][0]).toBeCloseTo(0.5, 6);
  });

  it('keeps the audio clip gain free of volume, strip and master gain', async () => {
    store.tracks = [
      makeTrack(1, { kind: 'audio', volume: 0.5, mixer: { ...createDefaultStrip(), gainDb: 6 } }),
    ];
    store.clips = [makeAudioClip(10, 1, { gain: 0.8, lengthPpq: 0.4 })];
    store.mixer.master.gainDb = -6;
    const { handle, addClip } = makeHandle(10);

    await scheduleProjectClips(handle, { loadAudioAsset: makeAssetLoader(10) });
    const opts = addClip.mock.calls[0][3] as { gain: number };
    expect(opts.gain).toBe(0.8);
  });

  it('schedules audio at exactly the clip gain when the mixer is neutral', async () => {
    store.tracks = [makeTrack(1, { kind: 'audio', volume: 0.5 })];
    store.clips = [makeAudioClip(10, 1, { gain: 0.8, lengthPpq: 0.4 })];
    const { handle, addClip } = makeHandle(10);

    await scheduleProjectClips(handle, { loadAudioAsset: makeAssetLoader(10) });
    expect((addClip.mock.calls[0][3] as { gain: number }).gain).toBe(0.8);
  });

  it('leaves scheduled audio buffers pan-free (pan is engine lane state)', async () => {
    store.tracks = [makeTrack(1, { kind: 'audio', mixer: { ...createDefaultStrip(), pan: -0.5 } })];
    store.clips = [makeAudioClip(10, 1, { lengthPpq: 0.4 })];
    store.mixer.master.pan = 0.25;
    const { handle, addClip } = makeHandle(10);

    await scheduleProjectClips(handle, { loadAudioAsset: makeAssetLoader(10) });
    const channels = addClip.mock.calls[0][1] as Float32Array[];
    expect(channels[0][0]).toBeCloseTo(0.5, 6);
    expect(channels[1][0]).toBeCloseTo(0.5, 6);
  });

  it('legacy track.pan stays UI-only (buffers untouched)', async () => {
    store.tracks = [makeTrack(1, { kind: 'audio', pan: 1 })];
    store.clips = [makeAudioClip(10, 1, { lengthPpq: 0.4 })];
    const { handle, addClip } = makeHandle(10);

    await scheduleProjectClips(handle, { loadAudioAsset: makeAssetLoader(10) });
    const channels = addClip.mock.calls[0][1] as Float32Array[];
    expect(channels[0][0]).toBeCloseTo(0.5, 6);
    expect(channels[1][0]).toBeCloseTo(0.5, 6);
  });
});
