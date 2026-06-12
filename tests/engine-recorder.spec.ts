import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import type { RecorderOptions } from '@/engine/recorder';
import {
  createRecorder,
  defaultRecordOffsetSamples,
  INPUT_METER_TARGET_ID,
  MICROPHONE_CONSTRAINTS,
  NoMicrophoneError,
  NotSupportedError,
  RecorderStateError,
} from '@/engine/recorder';

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
    truePeakDbL: peakDbL,
    truePeakDbR: peakDbR,
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
  source: 'input';
  recordOffsetSamples: number;
}

/** Builds an EngineHandle stub with spied capture-path methods. */
function makeHandle(sampleRate = 100, baseLatency = 0) {
  const configureCapture = vi.fn();
  const armRecord = vi.fn(() => true);
  const punch = vi.fn(() => true);
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
  const node = { engineNode: true };
  const ctx = { sampleRate, baseLatency };
  const handle = {
    engine: {
      node,
      configureCapture,
      armRecord,
      punch,
      resetCapture,
      captureStatus,
      capturedAudio,
      onMeter,
    },
    ctx,
  } as unknown as EngineHandle;
  return {
    handle,
    configureCapture,
    armRecord,
    punch,
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
function makeDeps() {
  const tracks = [
    { stop: vi.fn(), getSettings: () => ({ channelCount: 2 }) },
  ] as unknown as MediaStreamTrack[];
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
      close: bindingClose,
    }),
  );
  const deps: RecorderOptions = { getUserMedia, bindInput };
  return { deps, stream, source, bindingClose, getUserMedia, bindInput };
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createRecorder microphone acquisition', () => {
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
      stopTracksOnClose: true,
    });
    // The idle config: a 1-second raw-input buffer with the monitor off.
    expect(configureCapture).toHaveBeenCalledTimes(1);
    expect(configureCapture).toHaveBeenCalledWith({
      bufferFrames: 100,
      channels: 2,
      source: 'input',
      recordOffsetSamples: 0,
      inputMonitor: { enabled: false, gain: 1 },
    });

    // Idempotent: a second request does not reacquire the device.
    await recorder.requestMicrophone();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(configureCapture).toHaveBeenCalledTimes(1);
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
    expect(recorder.isRecording()).toBe(false);
  });
});

describe('createRecorder capture', () => {
  it('configures, resets, arms and punches in order on start', async () => {
    const { handle, configureCapture, armRecord, punch, resetCapture } = makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(7);
    await recorder.start({ startPpq: 8, tempoBpm: 120, maxDurationSeconds: 30 });

    // Recording-size buffer: 30 s at 100 Hz = 3000 frames.
    expect(configureCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({ bufferFrames: 3000, channels: 2, source: 'input' }),
    );
    expect(armRecord).toHaveBeenCalledWith(7, true);
    // Punch-out = startPpq + maxDuration in PPQ (30 s at 120 BPM = 60 PPQ).
    expect(punch).toHaveBeenCalledWith(8, 68);
    const order = [
      configureCapture.mock.invocationCallOrder[1],
      resetCapture.mock.invocationCallOrder[0],
      armRecord.mock.invocationCallOrder[0],
      punch.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));

    await recorder.stop();
    expect(armRecord).toHaveBeenLastCalledWith(7, false);
  });

  it('sizes the buffer and punch window with the 300 s default duration', async () => {
    const { handle, configureCapture, punch } = makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);
    await recorder.start({ startPpq: 4, tempoBpm: 120 });
    expect(configureCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({ bufferFrames: 30000 }),
    );
    // 300 s at 120 BPM = 600 PPQ.
    expect(punch).toHaveBeenCalledWith(4, 604);
  });

  it('trims the latency offset from the head and returns the rest', async () => {
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
    expect(channel.length).toBe(20);
    expect(channel[0]).toBe(10);
    expect(channel[19]).toBe(29);
  });

  it('derives the default latency offset from the context latency', async () => {
    // baseLatency 0.1 s at 100 Hz = 10 frames trimmed.
    const { handle, setStatus, setAudio } = makeHandle(100, 0.1);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);
    await recorder.start({ startPpq: 0, tempoBpm: 120 });
    setAudio(rampChannels(1, 100));
    setStatus({ capturedFrames: 30 });
    const channel = (await recorder.stop())?.channels[0] as Float32Array;
    expect(channel.length).toBe(20);
    expect(channel[0]).toBe(10);
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

  it('returns null when the capture is shorter than the latency offset', async () => {
    const { handle, armRecord, setStatus, setAudio, resetCapture, configureCapture } =
      makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);
    await recorder.start({ startPpq: 4, tempoBpm: 120, recordOffsetSamples: 10 });
    setAudio(rampChannels(1, 100));
    setStatus({ capturedFrames: 10 }); // nothing beyond the trimmed head
    expect(await recorder.stop()).toBeNull();
    expect(armRecord).toHaveBeenLastCalledWith(1, false);
    // The engine capture is still reset and the idle config restored.
    expect(resetCapture).toHaveBeenCalledTimes(2);
    expect(configureCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({ bufferFrames: 100 }),
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
    expect(await recorder.stop()).not.toBeNull();
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
      expect.objectContaining({ bufferFrames: 100 }),
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
    const { handle, configureCapture } = makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();

    recorder.setMonitor(true, 2);
    expect(configureCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({
        bufferFrames: 100,
        inputMonitor: { enabled: true, gain: 2 },
      }),
    );

    recorder.setMonitor(false);
    expect(recorder.monitorEnabled()).toBe(false);
    expect(configureCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({ inputMonitor: { enabled: false, gain: 2 } }),
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
        bufferFrames: 3000,
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
    const { handle, armRecord, resetCapture } = makeHandle();
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(4);
    await recorder.start({ startPpq: 0, tempoBpm: 120 });

    recorder.dispose();
    expect(recorder.isRecording()).toBe(false);
    expect(armRecord).toHaveBeenLastCalledWith(4, false);
    expect(resetCapture).toHaveBeenCalledTimes(2); // start + dispose
  });

  it('rejects a microphone that finishes binding after dispose', async () => {
    const { handle, configureCapture } = makeHandle();
    const { deps, bindingClose } = makeDeps();
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
    expect(bindingClose).toHaveBeenCalled();
    expect(configureCapture).not.toHaveBeenCalled();
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
