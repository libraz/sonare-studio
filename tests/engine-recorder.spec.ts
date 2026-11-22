import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REALTIME_VOICE_CHANGER_PROCESSOR } from '@/engine/realtime-voice-changer';
import type { RecorderOptions } from '@/engine/recorder';
import {
  createRecorder,
  defaultRecordOffsetSamples,
  INPUT_METER_TARGET_ID,
  inputLatencySamples,
  MICROPHONE_CONSTRAINTS,
  microphoneConstraints,
  NoMicrophoneError,
  NotSupportedError,
  RecorderStateError,
} from '@/engine/recorder';
import { STREAMING_RETUNE_PROCESSOR } from '@/engine/streaming-retune';
import { ensureWasm } from '@/lib/wasm';
import { normalizeTempoMap } from '@/project/tempo-map';
import { fakeEngineHandle } from './fakes/engine';

const { presetConfigs } = vi.hoisted(() => {
  const makePod = (overrides: Record<string, number | boolean>) => ({
    inputGainDb: 0,
    outputGainDb: 0,
    wetMix: 1,
    retunePitchSemitones: 0,
    retuneMix: 0,
    formantFactor: 1,
    formantAmount: 0,
    formantBody: 0,
    formantBrightness: 0,
    formantNasal: 0,
    eqHighPassHz: 75,
    eqBodyDb: 0,
    eqPresenceDb: 0,
    eqAirDb: 0,
    gateThresholdDb: -55,
    gateAttackMs: 2,
    gateReleaseMs: 100,
    gateRangeDb: 18,
    compressorThresholdDb: -24,
    compressorRatio: 1.8,
    compressorAttackMs: 8,
    compressorReleaseMs: 120,
    compressorMakeupGainDb: 0.5,
    deesserFrequencyHz: 7200,
    deesserThresholdDb: -28,
    deesserRatio: 4,
    deesserRangeDb: 8,
    reverbMix: 0,
    reverbTimeMs: 320,
    reverbDamping: 0.55,
    reverbSeed: 1,
    limiterCeilingDb: -1,
    limiterReleaseMs: 50,
    limiterEnableIspLimiter: true,
    limiterIspCeilingDbtp: -1,
    ...overrides,
  });
  return {
    presetConfigs: {
      brightIdol: makePod({ retunePitchSemitones: 4, retuneMix: 1, outputGainDb: 2.2 }),
      darkVillain: makePod({ retunePitchSemitones: -9, retuneMix: 1, outputGainDb: 4.5 }),
    },
  };
});

vi.mock('@/lib/wasm', () => ({
  ensureWasm: vi.fn(async () => ({
    realtimeVoiceChangerPresetConfig: (preset: string) =>
      presetConfigs[preset as keyof typeof presetConfigs],
  })),
}));

/** Builds a full meter snapshot; only targetId and the peak fields matter here. */
function meterSnapshot(targetId: number, peakDbL: number, peakDbR = peakDbL) {
  return {
    type: 'meter' as const,
    targetId,
    frame: 0,
    peakDbL,
    peakDbR,
    rmsDbL: -60,
    rmsDbR: -60,
    correlation: 0,
    truePeakDbtpL: peakDbL,
    truePeakDbtpR: peakDbR,
    momentaryLufs: -60,
    shortTermLufs: -60,
    integratedLufs: -60,
    gainReductionDb: 0,
  };
}

type MeterSnapshot = ReturnType<typeof meterSnapshot>;

/** The engine-side capture status shape returned by the handle stub. */
interface FakeCaptureStatus {
  capturedFrames: number;
  overflowCount: number;
  armed: boolean;
  punchEnabled: boolean;
  source: 'input' | 'output';
  recordOffsetSamples: number;
}

/** Builds an EngineHandle stub with spied capture-path methods. */
function makeHandle(sampleRate = 100, baseLatency = 0) {
  const configureCapture = vi.fn();
  const armCapture = vi.fn();
  const resetCapture = vi.fn(async () => {});
  let status: FakeCaptureStatus = {
    capturedFrames: 0,
    overflowCount: 0,
    armed: false,
    punchEnabled: true,
    source: 'input',
    recordOffsetSamples: 0,
  };
  let audio: Float32Array[] = [];
  const captureStatus = vi.fn(async () => status);
  const capturedAudio = vi.fn(async () => audio);
  let meterCallback: ((meter: MeterSnapshot) => void) | null = null;
  const meterUnsubscribe = vi.fn(() => {
    meterCallback = null;
  });
  const onMeter = vi.fn((callback: (meter: MeterSnapshot) => void) => {
    meterCallback = callback;
    return meterUnsubscribe;
  });
  const node = { numberOfOutputs: 1 };
  const ctx = { sampleRate, baseLatency };
  const handle = fakeEngineHandle({
    engine: {
      node,
      configureCapture,
      armCapture,
      resetCapture,
      captureStatus,
      capturedAudio,
      onMeter,
    },
    ctx,
  });
  return {
    handle,
    configureCapture,
    armCapture,
    resetCapture,
    captureStatus,
    capturedAudio,
    onMeter,
    meterUnsubscribe,
    ctx,
    node,
    setStatus: (patch: Partial<FakeCaptureStatus>): void => {
      status = { ...status, ...patch };
    },
    setAudio: (channels: Float32Array[]): void => {
      audio = channels;
    },
    emitMeter: (meter: MeterSnapshot): void => meterCallback?.(meter),
  };
}

/** Builds injectable mic/bind fakes. */
function makeDeps(options: { channelCount?: number; trackLatencySeconds?: number } = {}) {
  const endedListeners = new Set<() => void>();
  const track = {
    stop: vi.fn(),
    getSettings: () => ({
      channelCount: options.channelCount ?? 2,
      ...(options.trackLatencySeconds !== undefined
        ? { latency: options.trackLatencySeconds }
        : {}),
    }),
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'ended') endedListeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'ended') endedListeners.delete(listener);
    }),
  };
  const tracks = [track] as unknown as MediaStreamTrack[];
  const stream = {
    getAudioTracks: () => tracks,
    getTracks: () => tracks,
  } as unknown as MediaStream;
  const source = { micSource: true } as unknown as AudioNode;
  const bindingClose = vi.fn();
  const getUserMedia = vi.fn(async () => stream);
  const bindInput = vi.fn(
    async (_ctx: AudioContext, _node: AudioWorkletNode, opts: { stream: MediaStream }) => ({
      stream: opts.stream,
      source,
      destroy: bindingClose,
    }),
  );
  const deps: RecorderOptions = { getUserMedia, bindInput };
  /** Fires the device 'ended' event (e.g. the mic was unplugged). */
  const endTrack = (): void => {
    for (const listener of [...endedListeners]) listener();
  };
  return { deps, stream, source, bindingClose, getUserMedia, bindInput, track, endTrack };
}

class FakeAudioNode {
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
}

class FakePort extends EventTarget {
  readonly postMessage = vi.fn();
  readonly start = vi.fn();
}

class FakeAudioWorkletNode extends FakeAudioNode {
  static instances: FakeAudioWorkletNode[] = [];
  readonly port = new FakePort();
  private readonly events = new EventTarget();
  readonly addEventListener = this.events.addEventListener.bind(this.events);
  readonly removeEventListener = this.events.removeEventListener.bind(this.events);
  constructor(
    readonly context: BaseAudioContext,
    readonly name: string,
    readonly options: AudioWorkletNodeOptions,
  ) {
    super();
    FakeAudioWorkletNode.instances.push(this);
    queueMicrotask(() =>
      this.port.dispatchEvent(new MessageEvent('message', { data: { type: 'ready' } })),
    );
  }
}

/** Full-capacity ramp buffers: channel c holds value i * (c + 1) at index i. */
function rampChannels(channels: number, capacityFrames: number): Float32Array[] {
  const result: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const channel = new Float32Array(capacityFrames);
    for (let i = 0; i < capacityFrames; i++) channel[i] = i * (c + 1);
    result.push(channel);
  }
  return result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

beforeEach(() => {
  // Retune/voice-changer bindings fetch the worklet's WASM bytes same-origin.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })),
  );
});

afterEach(() => {
  FakeAudioWorkletNode.instances = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('createRecorder microphone acquisition', () => {
  it('builds tracking-quality constraints for the selected input device', () => {
    expect(microphoneConstraints()).toEqual(MICROPHONE_CONSTRAINTS);
    expect(microphoneConstraints('usb-mic')).toEqual({
      audio: {
        ...(MICROPHONE_CONSTRAINTS.audio as MediaTrackConstraints),
        deviceId: { exact: 'usb-mic' },
      },
      video: false,
    });
  });

  it('requests tracking-quality constraints, binds the stream and configures the capture', async () => {
    const { handle, node, configureCapture } = makeHandle(100);
    const { deps, getUserMedia, bindInput, stream } = makeDeps();
    const recorder = createRecorder(handle, deps);
    expect(recorder.hasMicrophone()).toBe(false);
    expect(configureCapture).not.toHaveBeenCalled();

    await recorder.requestMicrophone();
    expect(recorder.hasMicrophone()).toBe(true);
    expect(getUserMedia).toHaveBeenCalledWith(MICROPHONE_CONSTRAINTS);
    const audio = MICROPHONE_CONSTRAINTS.audio as MediaTrackConstraints;
    expect(audio.echoCancellation).toBe(false);
    expect(audio.noiseSuppression).toBe(false);
    expect(audio.autoGainControl).toBe(false);
    expect(bindInput).toHaveBeenCalledWith(handle.ctx, node, {
      stream,
      stopTracksOnDestroy: true,
      signal: expect.any(AbortSignal),
      onProcessorError: expect.any(Function),
    });
    // The idle config: a 1-second raw-input buffer with the monitor off.
    expect(configureCapture).toHaveBeenCalledTimes(1);
    expect(configureCapture).toHaveBeenCalledWith({
      capacityFrames: 100,
      numChannels: 2,
      source: 'input',
      recordOffsetSamples: 0,
      inputMonitor: { enabled: false, gain: 1 },
    });

    // Idempotent: a second request does not reacquire the device.
    await recorder.requestMicrophone();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(configureCapture).toHaveBeenCalledTimes(1);
  });

  it('configures the capture with the channel count reported by a mono input', async () => {
    const { handle, configureCapture } = makeHandle(48_000);
    const { deps } = makeDeps({ channelCount: 1 });
    const recorder = createRecorder(handle, deps);

    await recorder.requestMicrophone();

    expect(configureCapture).toHaveBeenCalledWith(
      expect.objectContaining({ numChannels: 1, source: 'input' }),
    );
  });

  it('requests the selected input device when one is configured', async () => {
    const { handle } = makeHandle(100);
    const { deps, getUserMedia } = makeDeps();
    const recorder = createRecorder(handle, { ...deps, inputDeviceId: 'usb-mic' });

    await recorder.requestMicrophone();

    expect(getUserMedia).toHaveBeenCalledWith(microphoneConstraints('usb-mic'));
  });

  it('chains voice changer and StreamingRetune for the default input binding', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const { handle, ctx, node } = makeHandle(48_000);
    const source = new FakeAudioNode();
    Object.assign(ctx, { createMediaStreamSource: vi.fn(() => source) });
    const { stream, getUserMedia } = makeDeps();
    const recorder = createRecorder(handle, {
      getUserMedia,
      voiceChangerPreset: 'brightIdol',
      streamingRetuneSemitones: 7,
    });
    const wasm = await ensureWasm();
    const darkConfig = wasm.realtimeVoiceChangerPresetConfig('darkVillain');

    await recorder.requestMicrophone();

    const [voiceNode, retuneNode] = FakeAudioWorkletNode.instances;
    expect((ctx as AudioContext).createMediaStreamSource).toHaveBeenCalledWith(stream);
    expect(voiceNode.name).toBe(REALTIME_VOICE_CHANGER_PROCESSOR);
    expect(retuneNode.name).toBe(STREAMING_RETUNE_PROCESSOR);
    expect(source.connect).toHaveBeenCalledWith(voiceNode);
    expect(voiceNode.connect).toHaveBeenCalledWith(retuneNode);
    expect(retuneNode.connect).toHaveBeenCalledWith(node);
    expect(retuneNode.options.processorOptions).toMatchObject({ pitchSemitones: 7, mix: 1 });

    expect(recorder.setVoiceChangerPreset('darkVillain')).toBe(true);
    expect(
      recorder.setVoiceChangerPreset({
        schemaVersion: 4,
        id: 'custom',
        name: 'custom',
        category: 'custom',
        dsp: { formantFactor: 1.2 },
      }),
    ).toBe(false);
    expect(recorder.setStreamingRetuneSemitones(-5)).toBe(true);
    expect(voiceNode.port.postMessage).toHaveBeenCalledWith({
      type: 'setConfig',
      config: darkConfig,
    });
    expect(voiceNode.port.postMessage).toHaveBeenCalledTimes(1);
    expect(retuneNode.port.postMessage).toHaveBeenCalledWith({
      type: 'setConfig',
      config: { pitchSemitones: -5, mix: 1 },
    });
  });

  it('throws NotSupportedError when no capture API exists', async () => {
    const { handle } = makeHandle();
    const recorder = createRecorder(handle, {}); // jsdom: no mediaDevices
    await expect(recorder.requestMicrophone()).rejects.toBeInstanceOf(NotSupportedError);
  });

  it('throws NoMicrophoneError when access is denied and allows retrying', async () => {
    const { handle } = makeHandle();
    const { deps } = makeDeps();
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new Error('Permission denied'))
      .mockImplementation(deps.getUserMedia as () => Promise<MediaStream>);
    const recorder = createRecorder(handle, { ...deps, getUserMedia });

    await expect(recorder.requestMicrophone()).rejects.toBeInstanceOf(NoMicrophoneError);
    expect(recorder.hasMicrophone()).toBe(false);
    // The failed attempt does not poison the next one.
    await recorder.requestMicrophone();
    expect(recorder.hasMicrophone()).toBe(true);
  });
});

describe('createRecorder state machine', () => {
  it('rejects start without a microphone, without an armed track, and double start', async () => {
    const { handle } = makeHandle();
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    const startOptions = { startPpq: 0, tempoBpm: 120 };

    await expect(recorder.start(startOptions)).rejects.toBeInstanceOf(RecorderStateError);
    await recorder.requestMicrophone();
    await expect(recorder.start(startOptions)).rejects.toBeInstanceOf(RecorderStateError);
    recorder.arm(3);
    expect(recorder.armedTrackId()).toBe(3);
    await recorder.start(startOptions);
    expect(recorder.isRecording()).toBe(true);
    await expect(recorder.start(startOptions)).rejects.toBeInstanceOf(RecorderStateError);
    await recorder.stop();
    expect(recorder.isRecording()).toBe(false);
  });

  it('rejects stop and re-arm in the wrong state', async () => {
    const { handle } = makeHandle();
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await expect(recorder.stop()).rejects.toBeInstanceOf(RecorderStateError);
    await recorder.requestMicrophone();
    recorder.arm(1);
    await recorder.start({ startPpq: 0, tempoBpm: 120 });
    expect(() => recorder.arm(2)).toThrow(RecorderStateError);
    expect(() => recorder.disarm()).toThrow(RecorderStateError);
    await recorder.stop();
    recorder.disarm();
    expect(recorder.armedTrackId()).toBe(null);
  });

  it('locks start while reset is pending and never arms after disposal', async () => {
    const { handle, resetCapture, armCapture } = makeHandle();
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, { ...deps, captureSource: 'output' });
    recorder.arm(1);
    const resetGate = deferred<void>();
    resetCapture.mockImplementationOnce(() => resetGate.promise);

    const starting = recorder.start({ startPpq: 0, tempoBpm: 120 });
    await expect(recorder.start({ startPpq: 0, tempoBpm: 120 })).rejects.toBeInstanceOf(
      RecorderStateError,
    );
    expect(() => recorder.arm(2)).toThrow(RecorderStateError);
    recorder.dispose();
    resetGate.resolve();

    await expect(starting).rejects.toBeInstanceOf(RecorderStateError);
    expect(armCapture).not.toHaveBeenCalledWith({ armed: true });
    expect(recorder.isRecording()).toBe(false);
  });

  it('retains the active take when stop RPC fails so stop can be retried', async () => {
    const { handle, captureStatus, setStatus, setAudio } = makeHandle();
    const recorder = createRecorder(handle, { ...makeDeps().deps, captureSource: 'output' });
    recorder.arm(1);
    await recorder.start({ startPpq: 3, tempoBpm: 120, recordOffsetSamples: 0 });
    captureStatus.mockRejectedValueOnce(new Error('status failed'));

    await expect(recorder.stop()).rejects.toThrow('status failed');
    expect(recorder.isRecording()).toBe(true);
    await expect(recorder.start({ startPpq: 4, tempoBpm: 120 })).rejects.toBeInstanceOf(
      RecorderStateError,
    );

    setStatus({ capturedFrames: 2 });
    setAudio([new Float32Array([1, 2])]);
    await expect(recorder.stop()).resolves.toMatchObject({ startPpq: 3 });
    expect(recorder.isRecording()).toBe(false);
  });

  it('validates start options', async () => {
    const { handle } = makeHandle();
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);
    await expect(recorder.start({ startPpq: -1, tempoBpm: 120 })).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(recorder.start({ startPpq: 0, tempoBpm: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(
      recorder.start({ startPpq: 0, tempoBpm: 120, recordOffsetSamples: -5 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      recorder.start({ startPpq: 0, tempoBpm: 120, maxDurationSeconds: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(recorder.start({ startPpq: 4, endPpq: 4, tempoBpm: 120 })).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(recorder.start({ startPpq: 4, endPpq: 2, tempoBpm: 120 })).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(recorder.isRecording()).toBe(false);
  });

  it('records the master output without requesting a microphone', async () => {
    const { handle, configureCapture, armCapture, setStatus, setAudio } = makeHandle(100);
    const { deps, getUserMedia } = makeDeps();
    const recorder = createRecorder(handle, { ...deps, captureSource: 'output' });

    await recorder.requestMicrophone();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(recorder.hasMicrophone()).toBe(true);

    recorder.arm(7);
    await recorder.start({ startPpq: 2, endPpq: 4, tempoBpm: 60 });

    expect(configureCapture).toHaveBeenLastCalledWith({
      capacityFrames: 200,
      numChannels: 2,
      source: 'output',
      recordOffsetSamples: 0,
      inputMonitor: { enabled: false, gain: 1 },
      punch: { startPpq: 2, endPpq: 4 },
    });
    expect(armCapture).toHaveBeenLastCalledWith({ armed: true });

    setStatus({ capturedFrames: 3, source: 'output' });
    setAudio([new Float32Array([1, 2, 3])]);
    await expect(recorder.stop()).resolves.toMatchObject({
      sampleRate: 100,
      startPpq: 2,
      channels: [new Float32Array([1, 2, 3])],
    });
  });
});

describe('createRecorder capture', () => {
  it('configures with the punch window, resets and arms in order on start', async () => {
    const { handle, configureCapture, armCapture, resetCapture } = makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(7);
    await recorder.start({ startPpq: 8, tempoBpm: 120, maxDurationSeconds: 30 });

    // Recording-size buffer: 30 s at 100 Hz = 3000 frames.
    expect(configureCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({ capacityFrames: 3000, numChannels: 2, source: 'input' }),
    );
    // Capture is engine-global: the armed track is the host's own bookkeeping
    // and the engine rejects any id but its own. Arming track 7 therefore still
    // arms capture 0, and passing 7 through is what stopped recording working.
    expect(armCapture).toHaveBeenCalledWith({ armed: true });
    expect(recorder.armedTrackId()).toBe(7);
    // Punch-out = startPpq + maxDuration in PPQ (30 s at 120 BPM = 60 PPQ).
    expect(configureCapture).toHaveBeenCalledWith(
      expect.objectContaining({ punch: { startPpq: 8, endPpq: 68 } }),
    );
    const order = [
      configureCapture.mock.invocationCallOrder[1],
      resetCapture.mock.invocationCallOrder[0],
      armCapture.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));

    await recorder.stop();
    expect(armCapture).toHaveBeenLastCalledWith({ armed: false });
  });

  it('sizes the buffer and punch window with the 300 s default duration', async () => {
    const { handle, configureCapture } = makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);
    await recorder.start({ startPpq: 4, tempoBpm: 120 });
    expect(configureCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({ capacityFrames: 30000 }),
    );
    // 300 s at 120 BPM = 600 PPQ.
    expect(configureCapture).toHaveBeenCalledWith(
      expect.objectContaining({ punch: { startPpq: 4, endPpq: 604 } }),
    );
  });

  it('uses an explicit punch-out position as the capture bound', async () => {
    const { handle, configureCapture } = makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);

    await recorder.start({ startPpq: 8, endPpq: 20, tempoBpm: 120 });

    // 12 PPQ at 120 BPM = 6 s; at 100 Hz the capture buffer is 600 frames.
    expect(configureCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({ capacityFrames: 600 }),
    );
    expect(configureCapture).toHaveBeenCalledWith(
      expect.objectContaining({ punch: { startPpq: 8, endPpq: 20 } }),
    );
  });

  it('uses the tempo-map punch-out for an open-ended take instead of constant BPM', async () => {
    const { handle, configureCapture } = makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);

    // A tempo ramp means the 300 s buffer spans more beats than 300 s at the
    // start tempo; the explicit punchOutPpq must win over the constant-BPM math.
    await recorder.start({ startPpq: 4, tempoBpm: 120, punchOutPpq: 900 });
    expect(configureCapture).toHaveBeenCalledWith(
      expect.objectContaining({ punch: { startPpq: 4, endPpq: 900 } }),
    );
  });

  it('derives an implicit punch-out through the supplied tempo map', async () => {
    const { handle, configureCapture } = makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);

    await recorder.start({
      startPpq: 8,
      tempoBpm: 120,
      maxDurationSeconds: 30,
      tempoMap: normalizeTempoMap([
        { startPpq: 0, bpm: 120 },
        { startPpq: 8, bpm: 60 },
      ]),
    });

    expect(configureCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({ capacityFrames: 3000 }),
    );
    // The 30-second buffer starts at 60 BPM, therefore spans 30 PPQ, not 60.
    expect(configureCapture).toHaveBeenCalledWith(
      expect.objectContaining({ punch: { startPpq: 8, endPpq: 38 } }),
    );
  });

  it('rejects a punch-out position at or before the start', async () => {
    const { handle } = makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);
    await expect(
      recorder.start({ startPpq: 4, tempoBpm: 120, punchOutPpq: 4 }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('passes the latency offset to the engine and returns the captured frames unshifted', async () => {
    const { handle, setStatus, setAudio } = makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);
    await recorder.start({ startPpq: 8, tempoBpm: 120, recordOffsetSamples: 10 });

    // Full-capacity buffers; only the first 30 captured frames are valid.
    setAudio(rampChannels(1, 100));
    setStatus({ capturedFrames: 30 });

    const result = await recorder.stop();
    expect(result).not.toBeNull();
    expect(result?.startPpq).toBe(8);
    expect(result?.sampleRate).toBe(100);
    expect(result?.channels).toHaveLength(1);
    const channel = result?.channels[0] as Float32Array;
    // The engine owns the shift; the host keeps frame 0 as captured.
    expect(channel.length).toBe(30);
    expect(channel[0]).toBe(0);
    expect(channel[29]).toBe(29);
  });

  it('stays armed for the record offset when stopped while the transport runs', async () => {
    vi.useFakeTimers();
    try {
      const { handle, armCapture } = makeHandle(100);
      const { deps } = makeDeps();
      const recorder = createRecorder(handle, deps);
      await recorder.requestMicrophone();
      recorder.arm(1);
      await recorder.start({ startPpq: 0, tempoBpm: 120, recordOffsetSamples: 50 });
      armCapture.mockClear();

      const stopping = recorder.stop({ captureTail: true });
      // 50 samples at 100 Hz: the input played up to the stop arrives 500 ms later.
      await vi.advanceTimersByTimeAsync(499);
      expect(armCapture).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
      expect(armCapture).toHaveBeenCalledWith({ armed: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['a device-like 10 ms', 10],
    ['the headless 2 s', 2000],
  ])('keeps the whole requested span at %s record offset', async (_label, offsetMs) => {
    vi.useFakeTimers();
    try {
      // 1 kHz, so one millisecond is one sample.
      const { handle, armCapture, captureStatus, capturedAudio } = makeHandle(1000);
      // The engine captures what arrives `offset` after the render position,
      // from the punch-in until the disarm reaches it.
      let armedAt: number | null = null;
      let disarmedAt: number | null = null;
      armCapture.mockImplementation(({ armed }: { armed: boolean }) => {
        if (armed) armedAt = Date.now();
        else disarmedAt = Date.now();
      });
      const capturedFrames = (): number => {
        if (armedAt === null) return 0;
        const end = disarmedAt ?? Date.now();
        return Math.max(0, end - armedAt - offsetMs);
      };
      captureStatus.mockImplementation(async () => ({
        capturedFrames: capturedFrames(),
        overflowCount: 0,
        armed: disarmedAt === null,
        punchEnabled: true,
        source: 'input' as const,
        recordOffsetSamples: offsetMs,
      }));
      capturedAudio.mockImplementation(async () => [new Float32Array(60_000)]);
      const { deps } = makeDeps();
      const recorder = createRecorder(handle, deps);
      await recorder.requestMicrophone();
      recorder.arm(1);
      await recorder.start({ startPpq: 0, tempoBpm: 120, recordOffsetSamples: offsetMs });

      await vi.advanceTimersByTimeAsync(1000);
      const stopping = recorder.stop({ captureTail: true });
      await vi.advanceTimersByTimeAsync(offsetMs + 100);
      const result = await stopping;
      expect(result?.channels[0].length).toBe(1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads the take and restores the idle config only once the disarm has landed', async () => {
    const { handle, setStatus, setAudio, captureStatus, capturedAudio, configureCapture } =
      makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);
    await recorder.start({ startPpq: 0, tempoBpm: 120, recordOffsetSamples: 0 });
    setAudio(rampChannels(1, 10));
    setStatus({ capturedFrames: 10, armed: true });
    configureCapture.mockClear();
    // The ring disarm reaches the audio thread after two port round trips.
    captureStatus.mockImplementationOnce(async () => ({
      capturedFrames: 8,
      overflowCount: 0,
      armed: true,
      punchEnabled: true,
      source: 'input' as const,
      recordOffsetSamples: 0,
    }));
    captureStatus.mockImplementationOnce(async () => ({
      capturedFrames: 9,
      overflowCount: 0,
      armed: true,
      punchEnabled: true,
      source: 'input' as const,
      recordOffsetSamples: 0,
    }));
    setStatus({ armed: false });

    const result = await recorder.stop();
    expect(captureStatus).toHaveBeenCalledTimes(3);
    expect(capturedAudio.mock.invocationCallOrder[0]).toBeGreaterThan(
      captureStatus.mock.invocationCallOrder[2],
    );
    expect(configureCapture.mock.invocationCallOrder[0]).toBeGreaterThan(
      captureStatus.mock.invocationCallOrder[2],
    );
    expect(result?.channels[0].length).toBe(10);
  });

  it('fails the stop when the engine never confirms the disarm', async () => {
    vi.useFakeTimers();
    try {
      const { handle, setStatus } = makeHandle(100);
      const { deps } = makeDeps();
      const recorder = createRecorder(handle, deps);
      await recorder.requestMicrophone();
      recorder.arm(1);
      await recorder.start({ startPpq: 0, tempoBpm: 120, recordOffsetSamples: 0 });
      setStatus({ armed: true });

      const stopping = recorder.stop();
      const outcome = expect(stopping).rejects.toThrow('The engine did not disarm the capture');
      await vi.advanceTimersByTimeAsync(1000);
      await outcome;
      expect(recorder.isRecording()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disarms at once when the transport has already stopped', async () => {
    const { handle, armCapture } = makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);
    await recorder.start({ startPpq: 0, tempoBpm: 120, recordOffsetSamples: 50 });
    armCapture.mockClear();

    const stopping = recorder.stop({ captureTail: false });
    expect(armCapture).toHaveBeenCalledWith({ armed: false });
    await stopping;
  });

  it('sends the punch window unextended because the engine compensates the record offset', async () => {
    const { handle, configureCapture, setStatus, setAudio } = makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(7);

    await recorder.start({ startPpq: 0, endPpq: 1, tempoBpm: 120, recordOffsetSamples: 10 });
    // One PPQ at 120 BPM is 50 frames; the engine reads the window in compensated time.
    expect(configureCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({ capacityFrames: 50, recordOffsetSamples: 10 }),
    );
    expect(configureCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({ punch: { startPpq: 0, endPpq: 1 } }),
    );
    setStatus({ capturedFrames: 50 });
    setAudio([Float32Array.from({ length: 50 }, (_, index) => index)]);

    const result = await recorder.stop();
    expect(Array.from(result?.channels[0] ?? [])).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(recorder.capturePunchOutPpq()).toBeNull();
  });

  it('exposes the render position at which the punch window is fully captured', async () => {
    const { handle } = makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(7);
    expect(recorder.capturePunchOutPpq()).toBeNull();
    await recorder.start({ startPpq: 0, endPpq: 1, tempoBpm: 120, recordOffsetSamples: 10 });
    expect(recorder.capturePunchOutPpq()).toBeCloseTo(1.2);
  });

  it('fails the take when the engine refuses the punch window', async () => {
    const { handle, configureCapture, armCapture } = makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(7);
    configureCapture.mockImplementationOnce(() => {
      throw new RangeError('punch window refused');
    });
    await expect(recorder.start({ startPpq: 0, tempoBpm: 120 })).rejects.toBeInstanceOf(RangeError);
    expect(armCapture).not.toHaveBeenCalledWith({ armed: true });
    expect(recorder.isRecording()).toBe(false);
  });

  it('restates the punch window when the config is re-sent during a take', async () => {
    const { handle, configureCapture } = makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(7);
    await recorder.start({ startPpq: 4, tempoBpm: 120, maxDurationSeconds: 30 });
    recorder.setMonitor(true);
    expect(configureCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({ punch: { startPpq: 4, endPpq: 64 } }),
    );
  });

  it('derives the default latency offset from the context latency', async () => {
    // baseLatency 0.1 s at 100 Hz = 10 frames of engine-side offset.
    const { handle, configureCapture, setStatus, setAudio } = makeHandle(100, 0.1);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);
    await recorder.start({ startPpq: 0, tempoBpm: 120 });
    setAudio(rampChannels(1, 100));
    setStatus({ capturedFrames: 30 });
    expect(configureCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({ recordOffsetSamples: 10 }),
    );
    const channel = (await recorder.stop())?.channels[0] as Float32Array;
    expect(channel.length).toBe(30);
    expect(channel[0]).toBe(0);
  });

  it('adds the device input latency to the default offset', async () => {
    // baseLatency 0.1 s + track input latency 0.05 s at 100 Hz = 15 frames.
    const { handle, configureCapture, setStatus, setAudio } = makeHandle(100, 0.1);
    const { deps } = makeDeps({ trackLatencySeconds: 0.05 });
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    expect(configureCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({ recordOffsetSamples: 15 }),
    );
    recorder.arm(1);
    await recorder.start({ startPpq: 0, tempoBpm: 120 });
    expect(configureCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({ recordOffsetSamples: 15 }),
    );
    setAudio(rampChannels(1, 100));
    setStatus({ capturedFrames: 30 });
    const channel = (await recorder.stop())?.channels[0] as Float32Array;
    expect(channel.length).toBe(30);
    expect(channel[0]).toBe(0);
  });

  it('adds project playback PDC to the device record offset', async () => {
    const { handle, configureCapture, setStatus, setAudio } = makeHandle(100, 0.1);
    const { deps } = makeDeps({ trackLatencySeconds: 0.05 });
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);

    await recorder.start({ startPpq: 0, tempoBpm: 120, playbackLatencySamples: 24 });
    expect(configureCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({ recordOffsetSamples: 39 }),
    );
    setAudio(rampChannels(1, 100));
    setStatus({ capturedFrames: 50 });
    const channel = (await recorder.stop())?.channels[0] as Float32Array;
    expect(channel.length).toBe(50);
    expect(channel[0]).toBe(0);
  });

  it('preserves stereo channels independently', async () => {
    const { handle, setStatus, setAudio } = makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);
    await recorder.start({ startPpq: 0, tempoBpm: 120, recordOffsetSamples: 0 });
    setAudio(rampChannels(2, 100));
    setStatus({ capturedFrames: 4 });
    const result = await recorder.stop();
    expect(result?.channels).toHaveLength(2);
    expect(Array.from(result?.channels[0] ?? [])).toEqual([0, 1, 2, 3]);
    expect(Array.from(result?.channels[1] ?? [])).toEqual([0, 2, 4, 6]);
  });

  it('returns null when nothing was captured', async () => {
    const { handle, armCapture, setStatus, setAudio, resetCapture, configureCapture } =
      makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);
    await recorder.start({ startPpq: 4, tempoBpm: 120, recordOffsetSamples: 10 });
    setAudio(rampChannels(1, 100));
    setStatus({ capturedFrames: 0 });
    expect(await recorder.stop()).toBeNull();
    expect(armCapture).toHaveBeenLastCalledWith({ armed: false });
    // The engine capture is still reset and the idle config restored.
    expect(resetCapture).toHaveBeenCalledTimes(2);
    expect(configureCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({ capacityFrames: 100 }),
    );
  });

  it('clamps the take to the shortest returned channel', async () => {
    const { handle, setStatus, setAudio } = makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);
    await recorder.start({ startPpq: 0, tempoBpm: 120, recordOffsetSamples: 0 });
    setAudio(rampChannels(1, 50));
    setStatus({ capturedFrames: 1000 }); // larger than the buffers
    const channel = (await recorder.stop())?.channels[0] as Float32Array;
    expect(channel.length).toBe(50);
  });

  it('warns once when the engine reports a capture overflow', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { handle, setStatus, setAudio } = makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);
    await recorder.start({ startPpq: 0, tempoBpm: 120, recordOffsetSamples: 0 });
    setAudio(rampChannels(1, 100));
    setStatus({ capturedFrames: 30, overflowCount: 7 });
    expect(await recorder.stop()).toMatchObject({ overflowCount: 7 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('capture overflow: 7 samples'));
  });

  it('resets the capture and restores the idle config after a take', async () => {
    const { handle, resetCapture, configureCapture, setStatus, setAudio } = makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);
    await recorder.start({ startPpq: 0, tempoBpm: 120, recordOffsetSamples: 0 });
    expect(resetCapture).toHaveBeenCalledTimes(1); // before arming the take
    setAudio(rampChannels(1, 100));
    setStatus({ capturedFrames: 30 });
    await recorder.stop();
    expect(resetCapture).toHaveBeenCalledTimes(2); // after reading the take
    expect(configureCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({ capacityFrames: 100 }),
    );
  });
});

describe('createRecorder monitoring', () => {
  it('remembers the pre-mic monitor state and sends it with the first config', async () => {
    const { handle, configureCapture } = makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    recorder.setMonitor(true, 0.5); // before the mic exists: remembered
    expect(recorder.monitorEnabled()).toBe(true);
    expect(configureCapture).not.toHaveBeenCalled();

    await recorder.requestMicrophone();
    expect(configureCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({ inputMonitor: { enabled: true, gain: 0.5 } }),
    );
  });

  it('re-sends the capture config when the monitor is toggled', async () => {
    const { handle, configureCapture } = makeHandle(100, 0.1);
    const { deps } = makeDeps({ trackLatencySeconds: 0.05 });
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();

    recorder.setMonitor(true, 2);
    expect(configureCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({
        capacityFrames: 100,
        recordOffsetSamples: 15,
        inputMonitor: { enabled: true, gain: 2 },
      }),
    );

    recorder.setMonitor(false);
    expect(recorder.monitorEnabled()).toBe(false);
    expect(configureCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({
        recordOffsetSamples: 15,
        inputMonitor: { enabled: false, gain: 2 },
      }),
    );

    expect(() => recorder.setMonitor(true, -1)).toThrow(RangeError);
  });

  it('keeps the recording-size buffer when toggled during a take', async () => {
    const { handle, configureCapture } = makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);
    await recorder.start({ startPpq: 0, tempoBpm: 120, maxDurationSeconds: 30 });

    recorder.setMonitor(true);
    expect(configureCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({
        capacityFrames: 3000,
        inputMonitor: { enabled: true, gain: 1 },
      }),
    );
  });
});

describe('createRecorder input levels', () => {
  it('exposes the engine input meter target id', () => {
    expect(INPUT_METER_TARGET_ID).toBe(0xffff);
  });

  it('publishes input-capture snapshots as linear peaks and ignores other targets', () => {
    const { handle, emitMeter } = makeHandle();
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, { ...deps, levelIntervalMs: 0 });
    const levels: number[] = [];
    const unsubscribe = recorder.onLevel((peak) => levels.push(peak));

    emitMeter(meterSnapshot(0, 0)); // master record: not the input level
    expect(levels).toEqual([]);

    // Max across channels after dB -> linear: max(10^(-20/20), 10^(0/20)) = 1.
    emitMeter(meterSnapshot(INPUT_METER_TARGET_ID, -20, 0));
    expect(levels).toEqual([1]);

    emitMeter(meterSnapshot(INPUT_METER_TARGET_ID, -20, -40));
    expect(levels[1]).toBeCloseTo(0.1, 10);

    // Digital silence arrives as -Infinity dBFS and maps to 0.
    emitMeter(meterSnapshot(INPUT_METER_TARGET_ID, Number.NEGATIVE_INFINITY));
    expect(levels[2]).toBe(0);

    unsubscribe();
    emitMeter(meterSnapshot(INPUT_METER_TARGET_ID, 0));
    expect(levels).toHaveLength(3);
  });

  it('coalesces level callbacks within the throttle interval', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const { handle, emitMeter } = makeHandle();
      const { deps } = makeDeps();
      const recorder = createRecorder(handle, { ...deps, levelIntervalMs: 50 });
      const levels: number[] = [];
      recorder.onLevel((peak) => levels.push(peak));

      emitMeter(meterSnapshot(INPUT_METER_TARGET_ID, -20)); // first snapshot always emits
      emitMeter(meterSnapshot(INPUT_METER_TARGET_ID, 0)); // within the window: held back
      expect(levels).toHaveLength(1);
      expect(levels[0]).toBeCloseTo(0.1, 10);
      vi.setSystemTime(1_000_100);
      emitMeter(meterSnapshot(INPUT_METER_TARGET_ID, -40)); // window elapsed: max since last emit
      expect(levels).toHaveLength(2);
      expect(levels[1]).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createRecorder teardown', () => {
  it('dispose unsubscribes the meters and closes the binding', async () => {
    const { handle, meterUnsubscribe, emitMeter } = makeHandle();
    const { deps, bindingClose } = makeDeps();
    const recorder = createRecorder(handle, { ...deps, levelIntervalMs: 0 });
    const levels: number[] = [];
    recorder.onLevel((peak) => levels.push(peak));
    await recorder.requestMicrophone();

    recorder.dispose();
    expect(meterUnsubscribe).toHaveBeenCalledTimes(1);
    expect(bindingClose).toHaveBeenCalledTimes(1);
    expect(recorder.hasMicrophone()).toBe(false);
    emitMeter(meterSnapshot(INPUT_METER_TARGET_ID, 0)); // unsubscribed: dropped
    expect(levels).toEqual([]);

    // Idempotent and terminal.
    recorder.dispose();
    expect(bindingClose).toHaveBeenCalledTimes(1);
    await expect(recorder.requestMicrophone()).rejects.toBeInstanceOf(RecorderStateError);
    await expect(recorder.start({ startPpq: 0, tempoBpm: 120 })).rejects.toBeInstanceOf(
      RecorderStateError,
    );
  });

  it('dispose during a recording disarms the engine and resets the capture', async () => {
    const { handle, armCapture, resetCapture } = makeHandle();
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(4);
    await recorder.start({ startPpq: 0, tempoBpm: 120 });

    recorder.dispose();
    expect(recorder.isRecording()).toBe(false);
    expect(armCapture).toHaveBeenLastCalledWith({ armed: false });
    expect(resetCapture).toHaveBeenCalledTimes(2); // start + dispose
  });

  it('rejects a microphone that finishes binding after dispose', async () => {
    const { handle, configureCapture } = makeHandle();
    const { deps, bindingClose, track } = makeDeps();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowGum = vi.fn(async () => {
      await gate;
      return (deps.getUserMedia as () => Promise<MediaStream>)();
    });
    const recorder = createRecorder(handle, { ...deps, getUserMedia: slowGum });
    const pending = recorder.requestMicrophone();
    recorder.dispose();
    release();
    await expect(pending).rejects.toBeInstanceOf(RecorderStateError);
    expect(recorder.hasMicrophone()).toBe(false);
    expect(bindingClose).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(configureCapture).not.toHaveBeenCalled();
  });
});

describe('createRecorder device loss', () => {
  it('tears down the binding and notifies subscribers when the device ends', async () => {
    const { handle } = makeHandle();
    const { deps, bindingClose, endTrack } = makeDeps();
    const recorder = createRecorder(handle, deps);
    const lost = vi.fn();
    recorder.onMicrophoneLost(lost);

    await recorder.requestMicrophone();
    expect(recorder.hasMicrophone()).toBe(true);

    endTrack(); // the mic was unplugged

    expect(lost).toHaveBeenCalledTimes(1);
    expect(recorder.hasMicrophone()).toBe(false);
    expect(bindingClose).toHaveBeenCalled();
  });

  it('aborts an in-flight take when the device ends mid-recording', async () => {
    const { handle, armCapture, resetCapture } = makeHandle();
    const { deps, endTrack } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(2);
    await recorder.start({ startPpq: 0, tempoBpm: 120 });
    expect(recorder.isRecording()).toBe(true);

    endTrack();

    expect(recorder.isRecording()).toBe(false);
    expect(armCapture).toHaveBeenLastCalledWith({ armed: false });
    expect(resetCapture).toHaveBeenCalled();
    // The discarded take cannot be stopped (there is none in progress).
    await expect(recorder.stop()).rejects.toBeInstanceOf(RecorderStateError);
  });

  it('lets the user reacquire a microphone after a device loss', async () => {
    const { handle } = makeHandle();
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.onMicrophoneLost(() => {})();
    // After loss, requestMicrophone re-runs getUserMedia (binding was cleared).
    const { deps: deps2, endTrack } = makeDeps();
    const recorder2 = createRecorder(handle, deps2);
    await recorder2.requestMicrophone();
    endTrack();
    expect(recorder2.hasMicrophone()).toBe(false);
    await recorder2.requestMicrophone();
    expect(recorder2.hasMicrophone()).toBe(true);
  });

  it('resets the input level to zero after a take so the meter does not freeze', async () => {
    const { handle, emitMeter, setStatus, setAudio } = makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    const levels: number[] = [];
    recorder.onLevel((peak) => levels.push(peak));
    await recorder.requestMicrophone();
    recorder.arm(1);
    await recorder.start({ startPpq: 0, tempoBpm: 120, recordOffsetSamples: 0 });

    emitMeter(meterSnapshot(INPUT_METER_TARGET_ID, 0)); // 0 dBFS -> peak 1
    expect(levels.at(-1)).toBeGreaterThan(0);

    setStatus({ capturedFrames: 4 });
    setAudio(rampChannels(2, 4));
    await recorder.stop();

    // Stopping drops the meter to zero instead of leaving the last peak frozen.
    expect(levels.at(-1)).toBe(0);
  });
});

describe('defaultRecordOffsetSamples', () => {
  it('converts base + output latency to samples', () => {
    const ctx = { sampleRate: 48000, baseLatency: 0.01, outputLatency: 0.02 } as AudioContext;
    expect(defaultRecordOffsetSamples(ctx)).toBe(1440);
  });

  it('tolerates missing latency fields', () => {
    const ctx = { sampleRate: 48000 } as AudioContext;
    expect(defaultRecordOffsetSamples(ctx)).toBe(0);
  });
});

describe('inputLatencySamples', () => {
  /** Builds a stream whose audio tracks report the given latencies (seconds). */
  function streamWithLatencies(...latencies: Array<number | undefined>): MediaStream {
    const tracks = latencies.map((latency) => ({
      getSettings: () => (latency !== undefined ? { latency } : {}),
    })) as unknown as MediaStreamTrack[];
    return { getAudioTracks: () => tracks } as unknown as MediaStream;
  }

  it('converts the largest reported track latency to samples', () => {
    expect(inputLatencySamples(streamWithLatencies(0.01, 0.02), 48000)).toBe(960);
  });

  it('returns 0 when no track reports a latency', () => {
    expect(inputLatencySamples(streamWithLatencies(undefined), 48000)).toBe(0);
    expect(inputLatencySamples(streamWithLatencies(), 48000)).toBe(0);
  });
});

describe('createRecorder multi-device merge', () => {
  /** Builds a fresh media stream fake tagged with a device id. */
  function makeStream(deviceId: string): MediaStream {
    const track = {
      stop: vi.fn(),
      getSettings: () => ({ deviceId }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaStreamTrack;
    return {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
  }

  /** EngineHandle stub whose ctx exposes the merge Web Audio factories. */
  function makeMergeHandle() {
    const { handle, configureCapture } = makeHandle(48_000);
    const merger = { connect: vi.fn(), disconnect: vi.fn() };
    const sources: Array<{
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }> = [];
    const createChannelMerger = vi.fn(() => merger);
    const splitters: Array<{ connect: ReturnType<typeof vi.fn> }> = [];
    const createChannelSplitter = vi.fn(() => {
      const splitter = { connect: vi.fn() };
      splitters.push(splitter);
      return splitter;
    });
    const createMediaStreamSource = vi.fn(() => {
      const source = { connect: vi.fn(), disconnect: vi.fn() };
      sources.push(source);
      return source;
    });
    Object.assign(handle.ctx, {
      createChannelMerger,
      createChannelSplitter,
      createMediaStreamSource,
    });
    return {
      handle,
      configureCapture,
      merger,
      sources,
      splitters,
      createChannelMerger,
      createChannelSplitter,
      createMediaStreamSource,
    };
  }

  it('opens one stream per distinct device and merges them into the engine node', async () => {
    const {
      handle,
      configureCapture,
      merger,
      sources,
      splitters,
      createChannelMerger,
      createChannelSplitter,
      createMediaStreamSource,
    } = makeMergeHandle();
    const streams = new Map([
      ['mic-a', makeStream('mic-a')],
      ['mic-b', makeStream('mic-b')],
    ]);
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      const deviceId = ((constraints.audio as MediaTrackConstraints).deviceId as { exact?: string })
        ?.exact;
      return streams.get(deviceId ?? '') as MediaStream;
    });
    const recorder = createRecorder(handle, {
      getUserMedia,
      inputDeviceIds: ['mic-a', 'mic-b'],
    });

    await recorder.requestMicrophone();

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(createChannelMerger).toHaveBeenCalledWith(2);
    expect(createMediaStreamSource).toHaveBeenCalledTimes(2);
    // Device i's first channel (one-output splitter) feeds merger input i.
    expect(createChannelSplitter).toHaveBeenCalledWith(1);
    expect(sources[0].connect).toHaveBeenCalledWith(splitters[0]);
    expect(sources[1].connect).toHaveBeenCalledWith(splitters[1]);
    expect(splitters[0].connect).toHaveBeenCalledWith(merger, 0, 0);
    expect(splitters[1].connect).toHaveBeenCalledWith(merger, 0, 1);
    expect(merger.connect).toHaveBeenCalledWith(handle.engine.node);
    // The capture width follows the merged channel count, not a hardcoded 2.
    expect(configureCapture).toHaveBeenCalledWith(
      expect.objectContaining({ numChannels: 2, source: 'input' }),
    );
  });

  it('preserves the default input as a route beside an explicitly selected device', async () => {
    const { handle, createChannelMerger } = makeMergeHandle();
    const defaultStream = makeStream('default');
    const usbStream = makeStream('mic-b');
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      const deviceId = ((constraints.audio as MediaTrackConstraints).deviceId as { exact?: string })
        ?.exact;
      return deviceId === 'mic-b' ? usbStream : defaultStream;
    });
    const recorder = createRecorder(handle, {
      getUserMedia,
      inputDeviceIds: [undefined, 'mic-b'],
    });

    await recorder.requestMicrophone();

    expect(getUserMedia).toHaveBeenNthCalledWith(1, MICROPHONE_CONSTRAINTS);
    expect(getUserMedia).toHaveBeenNthCalledWith(2, microphoneConstraints('mic-b'));
    expect(createChannelMerger).toHaveBeenCalledWith(2);
  });

  it('caps the merge at the capture channel limit and drops extra devices', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { handle, createChannelMerger } = makeMergeHandle();
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      const deviceId = ((constraints.audio as MediaTrackConstraints).deviceId as { exact?: string })
        ?.exact;
      return makeStream(deviceId ?? '');
    });
    const recorder = createRecorder(handle, {
      getUserMedia,
      inputDeviceIds: ['mic-a', 'mic-b', 'mic-c'],
      captureChannelLimit: 2,
    });

    await recorder.requestMicrophone();

    // Only the first two devices are opened; the third is dropped with a warning.
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(createChannelMerger).toHaveBeenCalledWith(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('capped at 2'));
  });

  it('keeps the single-device path when fewer than two distinct devices are requested', async () => {
    const { handle, createChannelMerger } = makeMergeHandle();
    const { deps, getUserMedia } = makeDeps();
    const recorder = createRecorder(handle, { ...deps, inputDeviceIds: ['mic-a'] });

    await recorder.requestMicrophone();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith(microphoneConstraints('mic-a'));
    expect(createChannelMerger).not.toHaveBeenCalled();
  });
});
