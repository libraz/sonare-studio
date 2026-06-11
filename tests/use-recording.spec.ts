import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { useRecording } from '@/composables/useRecording';
import type { UseTransportReturn } from '@/composables/useTransport';
import type { EngineHandle } from '@/engine/engine';
import type { Recorder, RecordingResult, StartRecordingOptions } from '@/engine/recorder';
import { NoMicrophoneError } from '@/engine/recorder';
import type { AudioAssetMeta } from '@/persistence/assets';
import { addAudioTrack, clearHistory } from '@/project/commands';
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
    onLevel: vi.fn((listener: (peak: number) => void) => {
      levelListener = listener;
      return () => {
        levelListener = null;
      };
    }),
    start: vi.fn((options: StartRecordingOptions) => {
      recording = true;
      lastStart = options;
      if (nextResult) nextResult.startPpq = options.startPpq;
    }),
    stop: vi.fn(() => {
      recording = false;
      return nextResult;
    }),
    dispose: vi.fn(),
  };
  return {
    rec,
    emitLevel: (peak: number) => levelListener?.(peak),
    setResult: (result: RecordingResult | null) => {
      nextResult = result;
    },
    getLastStart: () => lastStart,
  };
}

const fakeHandle = { engine: {}, ctx: { sampleRate: 48000 } } as unknown as EngineHandle;

const ingestMock = vi.fn(
  async (channels: Float32Array[], sampleRate: number, name: string): Promise<AudioAssetMeta> => ({
    id: 'rec-asset',
    name,
    sampleRate,
    numChannels: channels.length,
    numFrames: channels[0]?.length ?? 0,
  }),
);

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
    ingestMock.mockClear();
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

    recording.arm(null);
    expect(recording.armedTrackId.value).toBeNull();
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
    expect(fake.getLastStart()).toEqual({ startPpq: 8, tempoBpm: 120, countInPpq: 0 });
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
    expect(fake.getLastStart()).toEqual({ startPpq: 8, tempoBpm: 120, countInPpq: 4 });
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
    expect(fake.getLastStart()?.countInPpq).toBe(2);
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
    expect(fake.getLastStart()).toEqual({ startPpq: 16, tempoBpm: 120, countInPpq: 0 });
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
    expect(fake.rec.start).not.toHaveBeenCalled();
  });

  it('stopping the transport ends the take and still lands the clip', async () => {
    const { recording, transport } = setup();
    const trackId = addAudioTrack();
    recording.arm(trackId);
    await recording.record();
    expect(recording.isRecording.value).toBe(true);

    transport.stop();
    expect(recording.isRecording.value).toBe(false);
    await vi.waitFor(() => {
      expect(store.clips.some((c) => c.assetId === 'rec-asset')).toBe(true);
    });
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
});
