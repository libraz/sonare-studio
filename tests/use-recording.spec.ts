import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, effectScope, ref } from 'vue';
import { useRecording } from '@/composables/useRecording';
import type { UseTransportReturn } from '@/composables/useTransport';
import type { EngineHandle } from '@/engine/engine';
import type { Recorder, RecordingResult, StartRecordingOptions } from '@/engine/recorder';
import { NoMicrophoneError } from '@/engine/recorder';
import type { AudioAssetMeta } from '@/persistence/assets';
import {
  addAudioTrack,
  clearHistory,
  setTempoSegments,
  setTrackRecordInputChannel,
  setTrackRecordInputDeviceId,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

/** Builds a transport double satisfying UseTransportReturn with spies. */
function makeTransport(tempoBpm = 120) {
  const isPlaying = ref(false);
  const positionSeconds = ref(0);
  const tempo = ref(tempoBpm);
  const metronomeEnabled = ref(false);
  const positionPpq = computed(() => (positionSeconds.value * tempo.value) / 60);
  const play = vi.fn(() => {
    isPlaying.value = true;
    return true;
  });
  const stop = vi.fn(() => {
    isPlaying.value = false;
    return true;
  });
  const seekPpq = vi.fn((ppq: number) => {
    positionSeconds.value = (ppq * 60) / tempo.value;
    return true;
  });
  const toggleMetronome = vi.fn((enabled?: boolean) => {
    metronomeEnabled.value = enabled ?? !metronomeEnabled.value;
    return metronomeEnabled.value;
  });
  const transport: UseTransportReturn = {
    isPlaying,
    positionSeconds,
    positionPpq,
    tempo,
    loopEnabled: ref(false),
    loopStartPpq: ref(0),
    loopEndPpq: ref(0),
    metronomeEnabled,
    play,
    stop,
    seek: vi.fn(() => true),
    seekPpq,
    setTempo: vi.fn(),
    setLoop: vi.fn(() => true),
    toggleMetronome,
    dispose: vi.fn(),
  };
  return { transport, play, stop, seekPpq, toggleMetronome };
}

/** Controllable Recorder double. */
function makeFakeRecorder() {
  let mic = false;
  let armed: number | null = null;
  let recording = false;
  let levelListener: ((peak: number) => void) | null = null;
  let micLostListener: (() => void) | null = null;
  let nextResult: RecordingResult | null = {
    channels: [new Float32Array(24000)],
    sampleRate: 48000,
    startPpq: 0,
  };
  let lastStart: StartRecordingOptions | null = null;
  const rec: Recorder = {
    requestMicrophone: vi.fn(async () => {
      mic = true;
    }),
    hasMicrophone: () => mic,
    arm: vi.fn((trackId: number) => {
      armed = trackId;
    }),
    disarm: vi.fn(() => {
      armed = null;
    }),
    armedTrackId: () => armed,
    isRecording: () => recording,
    setMonitor: vi.fn(),
    monitorEnabled: () => false,
    setVoiceChangerPreset: vi.fn(() => true),
    setStreamingRetuneSemitones: vi.fn(() => true),
    onLevel: vi.fn((listener: (peak: number) => void) => {
      levelListener = listener;
      return () => {
        levelListener = null;
      };
    }),
    onMicrophoneLost: vi.fn((listener: () => void) => {
      micLostListener = listener;
      return () => {
        micLostListener = null;
      };
    }),
    start: vi.fn(async (options: StartRecordingOptions) => {
      recording = true;
      lastStart = options;
      if (nextResult) nextResult.startPpq = options.startPpq;
    }),
    stop: vi.fn(async () => {
      recording = false;
      return nextResult;
    }),
    dispose: vi.fn(),
  };
  return {
    rec,
    emitLevel: (peak: number) => levelListener?.(peak),
    emitMicLost: () => {
      mic = false;
      recording = false;
      micLostListener?.();
    },
    setResult: (result: RecordingResult | null) => {
      nextResult = result;
    },
    getLastStart: () => lastStart,
  };
}

const fakeHandle = { engine: {}, ctx: { sampleRate: 48000 } } as unknown as EngineHandle;

const defaultIngest = async (
  channels: Float32Array[],
  sampleRate: number,
  name: string,
): Promise<AudioAssetMeta> => ({
  id: 'rec-asset',
  name,
  sampleRate,
  numChannels: channels.length,
  numFrames: channels[0]?.length ?? 0,
});

const ingestMock = vi.fn(defaultIngest);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

describe('useRecording', () => {
  let store: ReturnType<typeof useProjectStore>;
  const disposers: Array<() => void> = [];

  /** Wires the composable with a fake recorder, transport and ingest. */
  function setup(handle: EngineHandle | null = fakeHandle) {
    const handleRef = ref<EngineHandle | null>(handle);
    const fake = makeFakeRecorder();
    const factory = vi.fn(() => fake.rec);
    const { transport, play, stop, seekPpq, toggleMetronome } = makeTransport();
    const recording = useRecording(() => handleRef.value, transport, {
      createRecorder: factory,
      ingest: ingestMock,
    });
    disposers.push(recording.dispose);
    return { recording, handleRef, fake, factory, transport, play, stop, seekPpq, toggleMetronome };
  }

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    ingestMock.mockReset();
    ingestMock.mockImplementation(defaultIngest);
    await store.init();
  });

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    vi.useRealTimers();
  });

  it('record() fails with a clear message while the engine is not started', async () => {
    const { recording, factory } = setup(null);
    expect(await recording.record()).toBe(false);
    expect(recording.error.value).toBe('Start the engine before recording.');
    expect(recording.isRecording.value).toBe(false);
    expect(factory).not.toHaveBeenCalled();

    expect(await recording.requestMic()).toBe(false);
    expect(recording.error.value).toBe('Start the engine before recording.');
  });

  it('arm() accepts audio tracks only and supports disarming', () => {
    const { recording } = setup();
    const midiTrackId = store.tracks[0].id; // store.init seeds one MIDI track
    const audioTrackId = addAudioTrack({ name: 'Vox' });

    recording.arm(midiTrackId);
    expect(recording.error.value).toBe('Recording requires an audio track.');
    expect(recording.armedTrackId.value).toBeNull();

    recording.arm(9999);
    expect(recording.error.value).toContain('Unknown track id');

    recording.arm(audioTrackId);
    expect(recording.error.value).toBeNull();
    expect(recording.armedTrackId.value).toBe(audioTrackId);
    expect(recording.armedTrackIds.value).toEqual([audioTrackId]);

    recording.arm(null);
    expect(recording.armedTrackId.value).toBeNull();
    expect(recording.armedTrackIds.value).toEqual([]);
  });

  it('arms multiple audio tracks and lands one captured take on each destination', async () => {
    const { recording, fake } = setup();
    const firstTrackId = addAudioTrack({ name: 'Vox 1' });
    const secondTrackId = addAudioTrack({ name: 'Vox 2' });

    recording.setTrackArmed(firstTrackId, true);
    recording.setTrackArmed(secondTrackId, true);
    expect(recording.armedTrackId.value).toBe(firstTrackId);
    expect(recording.armedTrackIds.value).toEqual([firstTrackId, secondTrackId]);

    expect(await recording.record()).toBe(true);
    expect(fake.rec.arm).toHaveBeenCalledWith(firstTrackId);

    const firstClipId = await recording.stopRecord();
    expect(firstClipId).not.toBeNull();
    expect(ingestMock).toHaveBeenCalledTimes(1);

    const clips = store.clips.filter((clip) => clip.kind === 'audio');
    expect(clips).toHaveLength(2);
    expect(clips.map((clip) => clip.trackId)).toEqual([firstTrackId, secondTrackId]);
    expect(new Set(clips.map((clip) => clip.assetId))).toEqual(new Set(['rec-asset']));
  });

  it('splits multi-channel input captures across multiple armed audio tracks', async () => {
    const { recording, fake } = setup();
    const firstTrackId = addAudioTrack({ name: 'Mic 1' });
    const secondTrackId = addAudioTrack({ name: 'Mic 2' });
    fake.setResult({
      channels: [new Float32Array([1, 1, 1]), new Float32Array([2, 2, 2])],
      sampleRate: 48000,
      startPpq: 0,
    });
    ingestMock.mockImplementation(async (channels, sampleRate, name) => ({
      id: name.includes('Ch 1') ? 'mic-1-asset' : 'mic-2-asset',
      name,
      sampleRate,
      numChannels: channels.length,
      numFrames: channels[0]?.length ?? 0,
    }));

    recording.setTrackArmed(firstTrackId, true);
    recording.setTrackArmed(secondTrackId, true);

    expect(await recording.record()).toBe(true);
    const firstClipId = await recording.stopRecord();

    expect(firstClipId).not.toBeNull();
    expect(ingestMock).toHaveBeenCalledTimes(2);
    expect(ingestMock.mock.calls.map((call) => call[0].length)).toEqual([1, 1]);
    expect(ingestMock.mock.calls.map((call) => call[0][0][0])).toEqual([1, 2]);
    expect(ingestMock.mock.calls.map((call) => call[2])).toEqual([
      'Recording 1 — Ch 1',
      'Recording 1 — Ch 2',
    ]);

    const clips = store.clips.filter((clip) => clip.kind === 'audio');
    expect(clips.map((clip) => [clip.trackId, clip.assetId])).toEqual([
      [firstTrackId, 'mic-1-asset'],
      [secondTrackId, 'mic-2-asset'],
    ]);
  });

  it('uses track record-input channel overrides when splitting input captures', async () => {
    const { recording, fake } = setup();
    const firstTrackId = addAudioTrack({ name: 'Mic 2' });
    const secondTrackId = addAudioTrack({ name: 'Mic 1' });
    setTrackRecordInputChannel(firstTrackId, 1);
    setTrackRecordInputChannel(secondTrackId, 0);
    fake.setResult({
      channels: [new Float32Array([1, 1, 1]), new Float32Array([2, 2, 2])],
      sampleRate: 48000,
      startPpq: 0,
    });
    ingestMock.mockImplementation(async (channels, sampleRate, name) => ({
      id: `${name}-${channels[0][0]}`,
      name,
      sampleRate,
      numChannels: channels.length,
      numFrames: channels[0]?.length ?? 0,
    }));

    recording.setTrackArmed(firstTrackId, true);
    recording.setTrackArmed(secondTrackId, true);

    expect(await recording.record()).toBe(true);
    await recording.stopRecord();

    expect(ingestMock).toHaveBeenCalledTimes(2);
    expect(ingestMock.mock.calls.map((call) => call[0][0][0])).toEqual([2, 1]);
    expect(ingestMock.mock.calls.map((call) => call[2])).toEqual([
      'Recording 1 — Ch 2',
      'Recording 1 — Ch 1',
    ]);
  });

  it('duplicates captures when there are fewer input channels than armed audio tracks', async () => {
    const { recording, fake } = setup();
    const firstTrackId = addAudioTrack({ name: 'Mic 1' });
    const secondTrackId = addAudioTrack({ name: 'Mic 2' });
    fake.setResult({
      channels: [new Float32Array([1, 1, 1])],
      sampleRate: 48000,
      startPpq: 0,
    });

    recording.setTrackArmed(firstTrackId, true);
    recording.setTrackArmed(secondTrackId, true);

    expect(await recording.record()).toBe(true);
    await recording.stopRecord();

    expect(ingestMock).toHaveBeenCalledTimes(1);
    const clips = store.clips.filter((clip) => clip.kind === 'audio');
    expect(new Set(clips.map((clip) => clip.assetId))).toEqual(new Set(['rec-asset']));
  });

  it('record() without an armed track sets an error', async () => {
    const { recording } = setup();
    expect(await recording.record()).toBe(false);
    expect(recording.error.value).toBe('Arm an audio track before recording.');
  });

  it('records and lands the take as an audio clip on the armed track', async () => {
    const { recording, fake, transport, play, stop, seekPpq } = setup();
    const trackId = addAudioTrack({ name: 'Vox' });
    recording.arm(trackId);
    transport.positionSeconds.value = 4; // 8 PPQ at 120 BPM

    expect(await recording.record()).toBe(true);
    expect(fake.rec.requestMicrophone).toHaveBeenCalledTimes(1); // auto-request
    expect(recording.micReady.value).toBe(true);
    expect(seekPpq).toHaveBeenCalledWith(8);
    expect(play).toHaveBeenCalledTimes(1);
    expect(fake.rec.arm).toHaveBeenCalledWith(trackId);
    expect(fake.getLastStart()).toEqual({ startPpq: 8, tempoBpm: 120 });
    expect(recording.isRecording.value).toBe(true);

    const clipId = await recording.stopRecord();
    expect(clipId).not.toBeNull();
    expect(recording.isRecording.value).toBe(false);
    expect(ingestMock).toHaveBeenCalledTimes(1);
    expect(ingestMock.mock.calls[0][1]).toBe(48000);
    expect(ingestMock.mock.calls[0][2]).toBe('Recording 1');

    const clip = store.clips.find((c) => c.id === clipId);
    // 24000 frames at 48 kHz = 0.5 s = 1 PPQ at 120 BPM.
    expect(clip).toMatchObject({
      trackId,
      kind: 'audio',
      assetId: 'rec-asset',
      name: 'Recording 1',
      startPpq: 8,
    });
    expect(clip?.lengthPpq).toBeCloseTo(1, 10);
    // DAW-standard: the transport keeps rolling after the take ends.
    expect(stop).not.toHaveBeenCalled();
    expect(transport.isPlaying.value).toBe(true);
  });

  it('arms capture before transport play and rejects a double-click while starting', async () => {
    const { recording, fake, play, transport } = setup();
    const trackId = addAudioTrack({ name: 'Vox' });
    recording.arm(trackId);
    const startGate = deferred<void>();
    const events: string[] = [];
    vi.mocked(fake.rec.start).mockImplementation(async () => {
      events.push('start:begin');
      await startGate.promise;
      events.push('start:ready');
    });
    play.mockImplementation(() => {
      events.push('transport:play');
      transport.isPlaying.value = true;
      return true;
    });

    const first = recording.record();
    await vi.waitFor(() => expect(recording.state.value).toBe('armed'));
    await expect(recording.record()).resolves.toBe(false);
    expect(fake.rec.start).toHaveBeenCalledTimes(1);
    expect(play).not.toHaveBeenCalled();

    startGate.resolve();
    await expect(first).resolves.toBe(true);
    expect(events).toEqual(['start:begin', 'start:ready', 'transport:play']);
    expect(recording.state.value).toBe('recording');
  });

  it('records the master output without requesting microphone access', async () => {
    const { recording, fake, factory } = setup();
    const trackId = addAudioTrack({ name: 'Bounce' });
    recording.arm(trackId);
    recording.setCaptureSource('output');

    expect(recording.captureSource.value).toBe('output');
    expect(await recording.record()).toBe(true);

    expect(factory).toHaveBeenCalledWith(
      fakeHandle,
      expect.objectContaining({ captureSource: 'output' }),
    );
    expect(fake.rec.requestMicrophone).not.toHaveBeenCalled();
    expect(fake.rec.arm).toHaveBeenCalledWith(trackId);
  });

  it('passes the selected input device id to the recorder factory', async () => {
    const { recording, factory } = setup();
    const trackId = addAudioTrack({ name: 'Vox' });
    recording.arm(trackId);
    recording.setInputDeviceId('usb-mic');

    expect(recording.inputDeviceId.value).toBe('usb-mic');
    expect(await recording.requestMic()).toBe(true);

    expect(factory).toHaveBeenCalledWith(
      fakeHandle,
      expect.objectContaining({ inputDeviceId: 'usb-mic' }),
    );
  });

  it('keeps default and explicit armed-track devices as separate capture routes', async () => {
    const { recording, factory, fake } = setup();
    const defaultTrackId = addAudioTrack({ name: 'Default Mic' });
    const usbTrackId = addAudioTrack({ name: 'USB Mic' });
    setTrackRecordInputDeviceId(usbTrackId, 'usb-mic');
    fake.setResult({
      channels: [new Float32Array([1, 1]), new Float32Array([2, 2])],
      sampleRate: 48_000,
      startPpq: 0,
    });
    ingestMock.mockImplementation(async (channels, sampleRate, name) => ({
      id: `${name}-${channels[0][0]}`,
      name,
      sampleRate,
      numChannels: channels.length,
      numFrames: channels[0]?.length ?? 0,
    }));
    recording.setTrackArmed(defaultTrackId, true);
    recording.setTrackArmed(usbTrackId, true);

    expect(await recording.record()).toBe(true);
    await recording.stopRecord();

    expect(factory).toHaveBeenCalledWith(
      fakeHandle,
      expect.objectContaining({ inputDeviceIds: ['', 'usb-mic'] }),
    );
    expect(ingestMock.mock.calls.map((call) => call[0][0][0])).toEqual([1, 2]);
  });

  it('surfaces capture overflow after storing the truncated recording', async () => {
    const { recording, fake } = setup();
    const trackId = addAudioTrack({ name: 'Vox' });
    recording.arm(trackId);
    fake.setResult({
      channels: [new Float32Array(24000)],
      sampleRate: 48000,
      startPpq: 0,
      overflowCount: 12,
    });

    expect(await recording.record()).toBe(true);
    const clipId = await recording.stopRecord();

    expect(clipId).not.toBeNull();
    expect(ingestMock).toHaveBeenCalledTimes(1);
    expect(recording.error.value).toBe(
      'Recording reached the capture buffer limit; the end of the take was dropped.',
    );
  });

  it('pre-rolls the count-in with a temporary metronome and restores it', async () => {
    vi.useFakeTimers();
    const { recording, fake, transport, seekPpq, toggleMetronome } = setup();
    const trackId = addAudioTrack();
    recording.arm(trackId);
    recording.countInBars.value = 1; // 4/4 default = 4 PPQ
    transport.positionSeconds.value = 4; // 8 PPQ

    expect(await recording.record()).toBe(true);
    expect(toggleMetronome).toHaveBeenCalledWith(true);
    expect(seekPpq).toHaveBeenCalledWith(4); // startPpq - countInPpq
    // The capture still starts at startPpq; the pre-roll is transport-only.
    expect(fake.getLastStart()).toEqual({ startPpq: 8, tempoBpm: 120 });
    expect(recording.isCountingIn.value).toBe(true);

    // 4 PPQ at 120 BPM = 2 s of count-in.
    vi.advanceTimersByTime(2000);
    expect(recording.isCountingIn.value).toBe(false);
    expect(transport.metronomeEnabled.value).toBe(false);
    expect(recording.isRecording.value).toBe(true);
  });

  it('clamps the count-in to the timeline start', async () => {
    const { recording, fake, seekPpq, transport } = setup();
    const trackId = addAudioTrack();
    recording.arm(trackId);
    recording.countInBars.value = 1;
    transport.positionSeconds.value = 1; // 2 PPQ < one bar

    await recording.record();
    expect(seekPpq).toHaveBeenCalledWith(0);
    expect(fake.getLastStart()).toEqual({ startPpq: 2, tempoBpm: 120 });
  });

  it('walks audio count-in over the variable-meter measure grid', async () => {
    const { recording, seekPpq, transport } = setup();
    const trackId = addAudioTrack();
    store.timeSignatures = [
      { startPpq: 0, numerator: 3, denominator: 4 },
      { startPpq: 6, numerator: 5, denominator: 8 },
    ];
    recording.arm(trackId);
    recording.countInBars.value = 1;
    transport.positionSeconds.value = 4.25; // 8.5 PPQ at 120 BPM

    expect(await recording.record()).toBe(true);
    expect(seekPpq).toHaveBeenCalledWith(6);
  });

  it('keeps a user-enabled metronome on after the count-in', async () => {
    vi.useFakeTimers();
    const { recording, transport, toggleMetronome } = setup();
    const trackId = addAudioTrack();
    recording.arm(trackId);
    recording.countInBars.value = 1;
    transport.positionSeconds.value = 4;
    transport.metronomeEnabled.value = true;

    await recording.record();
    expect(toggleMetronome).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(transport.metronomeEnabled.value).toBe(true);
  });

  it('punches in on a rolling transport without seeking or count-in', async () => {
    const { recording, fake, transport, play, seekPpq } = setup();
    const trackId = addAudioTrack();
    recording.arm(trackId);
    recording.countInBars.value = 2;
    transport.isPlaying.value = true;
    transport.positionSeconds.value = 8; // 16 PPQ

    expect(await recording.record()).toBe(true);
    expect(seekPpq).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    expect(fake.getLastStart()).toEqual({ startPpq: 16, tempoBpm: 120 });
  });

  it('records from an explicit punch-in position, ignoring count-in and loop snap', async () => {
    const { recording, fake, transport, play, seekPpq } = setup();
    const trackId = addAudioTrack();
    recording.arm(trackId);
    recording.countInBars.value = 2;
    transport.isPlaying.value = true;
    transport.positionSeconds.value = 8; // 16 PPQ — playhead already past the in-point
    transport.loopEnabled.value = true;
    transport.loopStartPpq.value = 4;
    transport.loopEndPpq.value = 12;

    // The auto-punch in-point (left locator) overrides the playhead, with no
    // count-in pre-roll and no cycle split.
    expect(await recording.record(4)).toBe(true);
    expect(seekPpq).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    expect(fake.getLastStart()).toEqual({ startPpq: 4, tempoBpm: 120 });

    const clipId = await recording.stopRecord();
    expect(clipId).not.toBeNull();
    const clip = store.clips.find((c) => c.id === clipId);
    expect(clip?.takes ?? []).toHaveLength(0); // single linear take, never cycle-split
  });

  it('passes an explicit punch-out position through to the recorder', async () => {
    const { recording, fake, transport } = setup();
    const trackId = addAudioTrack();
    recording.arm(trackId);
    recording.countInBars.value = 1;
    transport.isPlaying.value = true;
    transport.positionSeconds.value = 6;

    expect(await recording.record(4, 12)).toBe(true);
    expect(fake.getLastStart()).toEqual({
      startPpq: 4,
      tempoBpm: 120,
      endPpq: 12,
      maxDurationSeconds: 4,
    });
  });

  it('sizes an explicit punch range through the project tempo map', async () => {
    setTempoSegments([
      { startPpq: 0, bpm: 120 },
      { startPpq: 1, bpm: 60 },
    ]);
    const { recording, fake, transport } = setup();
    const trackId = addAudioTrack();
    recording.arm(trackId);
    transport.isPlaying.value = true;

    expect(await recording.record(1, 3)).toBe(true);
    expect(fake.getLastStart()).toEqual({
      startPpq: 1,
      tempoBpm: 120,
      endPpq: 3,
      maxDurationSeconds: 2,
    });
  });

  it('rejects an explicit punch-out at or before the punch-in', async () => {
    const { recording, fake } = setup();
    const trackId = addAudioTrack();
    recording.arm(trackId);

    expect(await recording.record(8, 8)).toBe(false);
    expect(recording.error.value).toBe('The punch-out locator must be after the punch-in locator.');
    expect(fake.rec.start).not.toHaveBeenCalled();
  });

  it('surfaces microphone errors from record()', async () => {
    const { recording, fake } = setup();
    const trackId = addAudioTrack();
    recording.arm(trackId);
    vi.mocked(fake.rec.requestMicrophone).mockRejectedValue(
      new NoMicrophoneError('Microphone access failed: denied'),
    );

    expect(await recording.record()).toBe(false);
    expect(recording.error.value).toBe('Microphone access failed: denied');
    expect(recording.isRecording.value).toBe(false);
    expect(fake.rec.start).not.toHaveBeenCalled();
  });

  it('reports an error when the engine rejects the play command', async () => {
    const { recording, play, fake } = setup();
    const trackId = addAudioTrack();
    recording.arm(trackId);
    play.mockReturnValue(false);

    expect(await recording.record()).toBe(false);
    expect(recording.error.value).toBe('The engine rejected the transport play command.');
    expect(fake.rec.start).toHaveBeenCalledOnce();
    expect(fake.rec.stop).toHaveBeenCalledOnce();
  });

  it('stopping the transport ends the take and still lands the clip', async () => {
    const { recording, transport } = setup();
    const trackId = addAudioTrack();
    recording.arm(trackId);
    await recording.record();
    expect(recording.isRecording.value).toBe(true);

    transport.stop();
    await vi.waitFor(() => {
      expect(recording.isRecording.value).toBe(false);
      expect(store.clips.some((c) => c.assetId === 'rec-asset')).toBe(true);
    });
  });

  it('blocks a new take while stop is pending and keeps metadata for a retry on RPC failure', async () => {
    const { recording, fake } = setup();
    const trackId = addAudioTrack({ name: 'Vox' });
    recording.arm(trackId);
    await recording.record();
    vi.mocked(fake.rec.stop).mockRejectedValueOnce(new Error('capture status failed'));

    await expect(recording.stopRecord()).resolves.toBeNull();
    expect(recording.state.value).toBe('recording');
    expect(recording.isRecording.value).toBe(true);
    await expect(recording.record()).resolves.toBe(false);

    const clipId = await recording.stopRecord();
    expect(clipId).not.toBeNull();
    expect(store.clips.find((clip) => clip.id === clipId)?.trackId).toBe(trackId);
    expect(recording.state.value).toBe('idle');
  });

  it('blocks stop-then-record re-entry until take ingestion completes', async () => {
    const { recording } = setup();
    const trackId = addAudioTrack({ name: 'Vox' });
    recording.arm(trackId);
    await recording.record();
    const ingestGate = deferred<AudioAssetMeta>();
    ingestMock.mockImplementationOnce(() => ingestGate.promise);

    const stopping = recording.stopRecord();
    await vi.waitFor(() => expect(recording.state.value).toBe('ingesting'));
    await expect(recording.record()).resolves.toBe(false);

    ingestGate.resolve(await defaultIngest([new Float32Array(1)], 48_000, 'Recording 1'));
    await expect(stopping).resolves.not.toBeNull();
    expect(recording.state.value).toBe('idle');
  });

  it('drops a delayed ingest when the project document changes', async () => {
    const { recording } = setup();
    const trackId = addAudioTrack({ name: 'Old project Vox' });
    recording.arm(trackId);
    await recording.record();
    const ingestGate = deferred<AudioAssetMeta>();
    ingestMock.mockImplementationOnce(() => ingestGate.promise);

    const stopping = recording.stopRecord();
    await vi.waitFor(() => expect(ingestMock).toHaveBeenCalledOnce());
    store.dispose();
    await store.init();
    ingestGate.resolve(await defaultIngest([new Float32Array(1)], 48_000, 'Recording 1'));

    await expect(stopping).resolves.toBeNull();
    expect(store.clips.some((clip) => clip.kind === 'audio')).toBe(false);
    expect(recording.state.value).toBe('idle');
  });

  it('does not ingest a stop result that resolves after disposal', async () => {
    const { recording, fake } = setup();
    const trackId = addAudioTrack({ name: 'Vox' });
    recording.arm(trackId);
    await recording.record();
    const stopGate = deferred<RecordingResult | null>();
    vi.mocked(fake.rec.stop).mockImplementationOnce(() => stopGate.promise);

    const stopping = recording.stopRecord();
    await vi.waitFor(() => expect(recording.state.value).toBe('stopping'));
    recording.dispose();
    stopGate.resolve({
      channels: [new Float32Array(128)],
      sampleRate: 48_000,
      startPpq: 0,
    });

    await expect(stopping).resolves.toBeNull();
    expect(ingestMock).not.toHaveBeenCalled();
    expect(recording.state.value).toBe('idle');
  });

  it('stopRecord() returns null without a clip when nothing was captured', async () => {
    const { recording, fake } = setup();
    const trackId = addAudioTrack();
    recording.arm(trackId);
    await recording.record();
    fake.setResult(null);

    expect(await recording.stopRecord()).toBeNull();
    expect(recording.isRecording.value).toBe(false);
    expect(ingestMock).not.toHaveBeenCalled();
    expect(store.clips.some((c) => c.kind === 'audio')).toBe(false);
  });

  it('stopRecord() surfaces ingestion failures as an error', async () => {
    const { recording } = setup();
    const trackId = addAudioTrack();
    recording.arm(trackId);
    await recording.record();
    ingestMock.mockRejectedValueOnce(new Error('disk full'));

    expect(await recording.stopRecord()).toBeNull();
    expect(recording.error.value).toBe('Failed to store the recording: disk full');
    expect(store.clips.some((c) => c.kind === 'audio')).toBe(false);
  });

  it('stopRecord() without a recording is a no-op', async () => {
    const { recording, fake } = setup();
    expect(await recording.stopRecord()).toBeNull();
    expect(fake.rec.stop).not.toHaveBeenCalled();
  });

  it('setMonitor delegates to the recorder and remembers the state', () => {
    const { recording, fake } = setup();
    recording.setMonitor(true, 0.8);
    expect(recording.monitorEnabled.value).toBe(true);
    expect(fake.rec.setMonitor).toHaveBeenLastCalledWith(true, 0.8);

    recording.setMonitor(false);
    expect(recording.monitorEnabled.value).toBe(false);
    expect(fake.rec.setMonitor).toHaveBeenLastCalledWith(false, undefined);
  });

  it('passes the selected realtime voice changer preset to new recorders', async () => {
    const { recording, factory, fake } = setup();
    recording.setVoiceChangerPreset('bright-idol');
    await recording.requestMic();

    expect(recording.voiceChangerPreset.value).toBe('bright-idol');
    expect(factory).toHaveBeenCalledWith(
      fakeHandle,
      expect.objectContaining({
        voiceChangerPreset: 'bright-idol',
        streamingRetuneSemitones: 0,
      }),
    );

    recording.setVoiceChangerPreset('off');
    expect(fake.rec.dispose).toHaveBeenCalledTimes(1);
    await recording.requestMic();
    expect(factory).toHaveBeenLastCalledWith(
      fakeHandle,
      expect.objectContaining({
        voiceChangerPreset: null,
        streamingRetuneSemitones: 0,
      }),
    );
  });

  it('passes custom realtime voice changer JSON presets to new recorders', async () => {
    const { recording, factory } = setup();
    const preset = {
      schemaVersion: 1 as const,
      name: 'Telephone',
      macros: { wet: 0.8 },
      dsp: { formantFactor: 1.2 },
    };

    recording.setVoiceChangerPreset(preset);
    await recording.requestMic();

    expect(recording.voiceChangerPreset.value).toEqual(preset);
    expect(factory).toHaveBeenCalledWith(
      fakeHandle,
      expect.objectContaining({
        voiceChangerPreset: preset,
        streamingRetuneSemitones: 0,
      }),
    );
  });

  it('passes StreamingRetune semitones to new recorders', async () => {
    const { recording, factory } = setup();
    recording.setStreamingRetuneSemitones(99);
    await recording.requestMic();

    expect(recording.streamingRetuneSemitones.value).toBe(24);
    expect(factory).toHaveBeenCalledWith(
      fakeHandle,
      expect.objectContaining({
        voiceChangerPreset: null,
        streamingRetuneSemitones: 24,
      }),
    );
  });

  it('hot-swaps realtime voice changer changes while recording when the binding supports it', async () => {
    const { recording, fake } = setup();
    const trackId = addAudioTrack({ name: 'Vox' });
    recording.arm(trackId);
    recording.setVoiceChangerPreset('bright-idol');
    await recording.record();

    recording.setVoiceChangerPreset('dark-villain');

    expect(recording.voiceChangerPreset.value).toBe('dark-villain');
    expect(fake.rec.setVoiceChangerPreset).toHaveBeenCalledWith('dark-villain');
    expect(recording.error.value).toBeNull();
  });

  it('defers voice changer type changes while recording when the active binding cannot update', async () => {
    const { recording, fake } = setup();
    vi.mocked(fake.rec.setVoiceChangerPreset).mockReturnValue(false);
    const trackId = addAudioTrack({ name: 'Vox' });
    recording.arm(trackId);
    await recording.record();

    recording.setVoiceChangerPreset('dark-villain');

    expect(recording.voiceChangerPreset.value).toBe('dark-villain');
    expect(recording.error.value).toBe(
      'Voice changer changes will apply to the next microphone binding.',
    );
  });

  it('hot-swaps StreamingRetune changes while recording when the binding supports it', async () => {
    const { recording, fake } = setup();
    const trackId = addAudioTrack({ name: 'Vox' });
    recording.arm(trackId);
    recording.setStreamingRetuneSemitones(3);
    await recording.record();

    recording.setStreamingRetuneSemitones(9.4);

    expect(recording.streamingRetuneSemitones.value).toBe(9);
    expect(fake.rec.setStreamingRetuneSemitones).toHaveBeenCalledWith(9);
    expect(recording.error.value).toBeNull();
  });

  it('setMonitor without an engine only records the desired state', () => {
    const { recording, factory } = setup(null);
    recording.setMonitor(true);
    expect(recording.monitorEnabled.value).toBe(true);
    expect(factory).not.toHaveBeenCalled();
  });

  it('mirrors recorder level callbacks into inputLevel', async () => {
    const { recording, fake } = setup();
    await recording.requestMic(); // creates the recorder and subscribes
    fake.emitLevel(0.42);
    expect(recording.inputLevel.value).toBe(0.42);
  });

  it('dispose releases the recorder', async () => {
    const { recording, fake } = setup();
    await recording.requestMic();
    recording.dispose();
    expect(fake.rec.dispose).toHaveBeenCalledTimes(1);
    expect(recording.micReady.value).toBe(false);
  });

  it('clears the count-in timer when its owning scope is stopped', async () => {
    vi.useFakeTimers();
    let context: ReturnType<typeof setup> | undefined;
    const scope = effectScope();
    scope.run(() => {
      context = setup();
    });
    if (!context) throw new Error('effect scope did not run');
    const { recording, transport, toggleMetronome } = context;
    const trackId = addAudioTrack();
    recording.arm(trackId);
    recording.countInBars.value = 1;
    transport.positionSeconds.value = 4;

    expect(await recording.record()).toBe(true);
    expect(recording.isCountingIn.value).toBe(true);

    scope.stop();
    expect(recording.isCountingIn.value).toBe(false);
    expect(toggleMetronome).toHaveBeenNthCalledWith(1, true);
    expect(toggleMetronome).toHaveBeenNthCalledWith(2, false);

    vi.advanceTimersByTime(2000);
    expect(toggleMetronome).toHaveBeenCalledTimes(2);
  });

  it('surfaces a device loss: clears mic state, stops recording and shows an error', async () => {
    const { recording, fake } = setup();
    await recording.requestMic();
    expect(recording.micReady.value).toBe(true);
    fake.emitLevel(0.3);
    expect(recording.inputLevel.value).toBe(0.3);

    fake.emitMicLost();

    expect(recording.micReady.value).toBe(false);
    expect(recording.isRecording.value).toBe(false);
    expect(recording.inputLevel.value).toBe(0);
    expect(recording.error.value).toMatch(/disconnected/i);
  });

  it('lengths a take through the tempo map when the project tempo varies', async () => {
    // Two constant segments: 120 BPM, then 240 BPM from ppq 1.
    setTempoSegments([
      { startPpq: 0, bpm: 120 },
      { startPpq: 1, bpm: 240 },
    ]);
    const { recording, fake } = setup();
    const trackId = addAudioTrack({ name: 'Vox' });
    recording.arm(trackId);
    // 0.75 s captured from ppq 0: the first 0.5 s fills ppq[0,1) at 120 BPM and
    // the remaining 0.25 s spans ppq[1,2) at 240 BPM -> 2 ppq. The old scalar
    // math (0.75 * 120/60) would have produced 1.5.
    fake.setResult({ channels: [new Float32Array(36000)], sampleRate: 48000, startPpq: 0 });

    expect(await recording.record()).toBe(true);
    const clipId = await recording.stopRecord();
    const clip = store.clips.find((c) => c.id === clipId);
    expect(clip?.lengthPpq).toBeCloseTo(2, 6);
  });

  it('lengths a take with the scalar tempo when the map is flat (backward compatible)', async () => {
    const { recording, fake } = setup();
    const trackId = addAudioTrack({ name: 'Vox' });
    recording.arm(trackId);
    // 0.5 s at a flat 120 BPM -> 1 ppq, matching the previous scalar result.
    fake.setResult({ channels: [new Float32Array(24000)], sampleRate: 48000, startPpq: 0 });
    expect(await recording.record()).toBe(true);
    const clipId = await recording.stopRecord();
    const clip = store.clips.find((c) => c.id === clipId);
    expect(clip?.lengthPpq).toBeCloseTo(1, 6);
  });

  describe('cycle recording', () => {
    /** Frames in one loop pass: 4 PPQ at 120 BPM = 2 s at 48 kHz. */
    const cycleFrames = 96000;

    /** Capture buffer whose value marks the loop pass it belongs to (1, 2, ...). */
    function makeCapture(frames: number): Float32Array {
      const buffer = new Float32Array(frames);
      for (let i = 0; i < frames; i++) buffer[i] = Math.floor(i / cycleFrames) + 1;
      return buffer;
    }

    /** Configures the transport loop window. */
    function setLoop(
      transport: UseTransportReturn,
      startPpq: number,
      endPpq: number,
      enabled = true,
    ): void {
      transport.loopEnabled.value = enabled;
      transport.loopStartPpq.value = startPpq;
      transport.loopEndPpq.value = endPpq;
    }

    it('splits complete loop passes into takes of one clip', async () => {
      const { recording, fake, transport } = setup();
      const trackId = addAudioTrack({ name: 'Vox' });
      recording.arm(trackId);
      setLoop(transport, 0, 4);
      // 2.5 passes: two complete cycles plus half a cycle of overhang.
      fake.setResult({
        channels: [makeCapture(cycleFrames * 2.5)],
        sampleRate: 48000,
        startPpq: 0,
      });
      ingestMock
        .mockImplementationOnce(async (channels, sampleRate, name) => ({
          id: 'take-asset-1',
          name,
          sampleRate,
          numChannels: channels.length,
          numFrames: channels[0]?.length ?? 0,
        }))
        .mockImplementationOnce(async (channels, sampleRate, name) => ({
          id: 'take-asset-2',
          name,
          sampleRate,
          numChannels: channels.length,
          numFrames: channels[0]?.length ?? 0,
        }));

      expect(await recording.record()).toBe(true);
      const clipId = await recording.stopRecord();
      expect(clipId).not.toBeNull();

      // Each complete pass is ingested as one take of exactly one loop.
      expect(ingestMock).toHaveBeenCalledTimes(2);
      for (const [index, call] of ingestMock.mock.calls.entries()) {
        const [channels, sampleRate, name] = call;
        expect(sampleRate).toBe(48000);
        expect(name).toBe(`Recording 1 — Take ${index + 1}`);
        expect(channels[0].length).toBe(cycleFrames);
        // The slice carries its pass marker from start to end.
        expect(channels[0][0]).toBe(index + 1);
        expect(channels[0][cycleFrames - 1]).toBe(index + 1);
      }

      // One clip spanning the loop window, last take selected.
      const clips = store.clips.filter((c) => c.kind === 'audio');
      expect(clips).toHaveLength(1);
      const clip = clips[0];
      expect(clip.id).toBe(clipId);
      expect(clip).toMatchObject({ trackId, startPpq: 0, lengthPpq: 4, assetId: 'take-asset-2' });
      expect(clip.takes).toEqual([
        { assetId: 'take-asset-1', name: 'Recording 1 — Take 1' },
        { assetId: 'take-asset-2', name: 'Recording 1 — Take 2' },
      ]);
      expect(clip.compSegments).toEqual([{ startPpq: 0, takeIndex: 1 }]);
    });

    it('splits multi-channel loop takes across multiple armed audio tracks', async () => {
      const { recording, fake, transport } = setup();
      const firstTrackId = addAudioTrack({ name: 'Mic 1' });
      const secondTrackId = addAudioTrack({ name: 'Mic 2' });
      recording.setTrackArmed(firstTrackId, true);
      recording.setTrackArmed(secondTrackId, true);
      setLoop(transport, 0, 4);
      fake.setResult({
        channels: [
          makeCapture(cycleFrames * 2),
          makeCapture(cycleFrames * 2).map((value) => value + 10),
        ],
        sampleRate: 48000,
        startPpq: 0,
      });
      ingestMock.mockImplementation(async (channels, sampleRate, name) => ({
        id: `${name}-${channels[0][0]}`,
        name,
        sampleRate,
        numChannels: channels.length,
        numFrames: channels[0]?.length ?? 0,
      }));

      expect(await recording.record()).toBe(true);
      await recording.stopRecord();

      expect(ingestMock).toHaveBeenCalledTimes(4);
      expect(ingestMock.mock.calls.map((call) => call[0].length)).toEqual([1, 1, 1, 1]);
      expect(ingestMock.mock.calls.map((call) => call[0][0][0])).toEqual([1, 2, 11, 12]);
      const clips = store.clips.filter((clip) => clip.kind === 'audio');
      expect(clips).toHaveLength(2);
      expect(clips.map((clip) => clip.trackId)).toEqual([firstTrackId, secondTrackId]);
      expect(clips[0].takes?.map((take) => take.assetId)).toEqual([
        'Recording 1 — Take 1-1',
        'Recording 1 — Take 2-2',
      ]);
      expect(clips[1].takes?.map((take) => take.assetId)).toEqual([
        'Recording 1 — Take 1-11',
        'Recording 1 — Take 2-12',
      ]);
    });

    it('uses track record-input channel overrides for loop takes', async () => {
      const { recording, fake, transport } = setup();
      const firstTrackId = addAudioTrack({ name: 'Mic 2' });
      const secondTrackId = addAudioTrack({ name: 'Mic 1' });
      setTrackRecordInputChannel(firstTrackId, 1);
      setTrackRecordInputChannel(secondTrackId, 0);
      recording.setTrackArmed(firstTrackId, true);
      recording.setTrackArmed(secondTrackId, true);
      setLoop(transport, 0, 4);
      fake.setResult({
        channels: [
          makeCapture(cycleFrames * 2),
          makeCapture(cycleFrames * 2).map((value) => value + 10),
        ],
        sampleRate: 48000,
        startPpq: 0,
      });
      ingestMock.mockImplementation(async (channels, sampleRate, name) => ({
        id: `${name}-${channels[0][0]}`,
        name,
        sampleRate,
        numChannels: channels.length,
        numFrames: channels[0]?.length ?? 0,
      }));

      expect(await recording.record()).toBe(true);
      await recording.stopRecord();

      expect(ingestMock).toHaveBeenCalledTimes(4);
      expect(ingestMock.mock.calls.map((call) => call[0][0][0])).toEqual([11, 12, 1, 2]);
    });

    it('anchors split boundaries instead of accumulating rounded loop-frame drift', async () => {
      const { recording, fake, transport } = setup();
      const trackId = addAudioTrack({ name: 'Vox' });
      recording.arm(trackId);
      setTempoSegments([{ startPpq: 0, bpm: 123 }]);
      setLoop(transport, 0, 1);
      const framesPerCycle = (60 / 123) * 48000;
      const captureFrames = Math.round(framesPerCycle * 3);
      fake.setResult({
        channels: [makeCapture(captureFrames)],
        sampleRate: 48000,
        startPpq: 0,
      });
      ingestMock.mockImplementation(async (channels, sampleRate, name) => ({
        id: name,
        name,
        sampleRate,
        numChannels: channels.length,
        numFrames: channels[0]?.length ?? 0,
      }));

      await recording.record();
      const clipId = await recording.stopRecord();

      expect(clipId).not.toBeNull();
      expect(ingestMock.mock.calls.map((call) => call[0][0].length)).toEqual([
        Math.round(framesPerCycle),
        Math.round(framesPerCycle * 2) - Math.round(framesPerCycle),
        Math.round(framesPerCycle * 3) - Math.round(framesPerCycle * 2),
      ]);
      const clip = store.clips.find((c) => c.id === clipId);
      expect(clip?.takes).toHaveLength(3);
      expect(clip?.lengthPpq).toBe(1);
    });

    it('falls back to one linear clip when fewer than two passes complete', async () => {
      const { recording, fake, transport } = setup();
      const trackId = addAudioTrack();
      recording.arm(trackId);
      setLoop(transport, 0, 4);
      fake.setResult({
        channels: [makeCapture(cycleFrames * 1.5)],
        sampleRate: 48000,
        startPpq: 0,
      });

      await recording.record();
      const clipId = await recording.stopRecord();
      expect(clipId).not.toBeNull();
      // The whole capture lands as one clip without takes.
      expect(ingestMock).toHaveBeenCalledTimes(1);
      expect(ingestMock.mock.calls[0][0][0].length).toBe(cycleFrames * 1.5);
      const clip = store.clips.find((c) => c.id === clipId);
      expect(clip?.takes).toBeUndefined();
      expect(clip?.compSegments).toBeUndefined();
      expect(clip?.startPpq).toBe(0);
      expect(clip?.lengthPpq).toBeCloseTo(6, 10); // 3 s at 120 BPM
    });

    it('ignores the loop window when looping is disabled', async () => {
      const { recording, fake, transport } = setup();
      const trackId = addAudioTrack();
      recording.arm(trackId);
      setLoop(transport, 0, 4, false);
      fake.setResult({
        channels: [makeCapture(cycleFrames * 2.5)],
        sampleRate: 48000,
        startPpq: 0,
      });

      await recording.record();
      const clipId = await recording.stopRecord();
      expect(ingestMock).toHaveBeenCalledTimes(1);
      const clip = store.clips.find((c) => c.id === clipId);
      expect(clip?.takes).toBeUndefined();
      expect(clip?.lengthPpq).toBeCloseTo(10, 10); // 5 s at 120 BPM
    });

    it('records one linear take when starting away from the loop start', async () => {
      const { recording, fake, transport } = setup();
      const trackId = addAudioTrack();
      recording.arm(trackId);
      setLoop(transport, 0, 4);
      transport.positionSeconds.value = 0.5; // 1 PPQ, not the loop start
      fake.setResult({
        channels: [makeCapture(cycleFrames * 2.5)],
        sampleRate: 48000,
        startPpq: 0, // overwritten by start() with the real punch position
      });

      await recording.record();
      const clipId = await recording.stopRecord();
      expect(ingestMock).toHaveBeenCalledTimes(1);
      const clip = store.clips.find((c) => c.id === clipId);
      expect(clip?.takes).toBeUndefined();
      expect(clip?.startPpq).toBe(1);
    });
  });
});
