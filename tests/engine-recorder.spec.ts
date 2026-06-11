import { describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import type { CaptureTap, RecorderOptions } from '@/engine/recorder';
import {
  createRecorder,
  defaultRecordOffsetSamples,
  MICROPHONE_CONSTRAINTS,
  NoMicrophoneError,
  NotSupportedError,
  RecorderStateError,
} from '@/engine/recorder';

/** Fake GainNode capturing connect/disconnect and gain writes. */
interface FakeGain {
  gain: { value: number };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

/** Builds an EngineHandle stub with spied record-path methods. */
function makeHandle(sampleRate = 100, baseLatency = 0) {
  const armRecord = vi.fn(() => true);
  const punch = vi.fn(() => true);
  const node = { engineNode: true };
  const destination = { destination: true };
  const gains: FakeGain[] = [];
  const ctx = {
    sampleRate,
    baseLatency,
    destination,
    createGain: vi.fn((): FakeGain => {
      const gain: FakeGain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      gains.push(gain);
      return gain;
    }),
  };
  const handle = { engine: { node, armRecord, punch }, ctx } as unknown as EngineHandle;
  return { handle, armRecord, punch, ctx, node, destination, gains };
}

/** Builds injectable mic/bind/tap fakes plus a block pusher. */
function makeDeps(channelCount = 2) {
  const tracks = [
    { stop: vi.fn(), getSettings: () => ({ channelCount }) },
  ] as unknown as MediaStreamTrack[];
  const stream = {
    getAudioTracks: () => tracks,
    getTracks: () => tracks,
  } as unknown as MediaStream;
  const source = { connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioNode;
  const bindingClose = vi.fn();
  const tapClose = vi.fn();
  let onBlock: ((channels: ReadonlyArray<Float32Array>) => void) | null = null;
  const getUserMedia = vi.fn(async () => stream);
  const bindInput = vi.fn(
    async (_ctx: AudioContext, _node: AudioWorkletNode, opts: { stream: MediaStream }) => ({
      stream: opts.stream,
      source,
      close: bindingClose,
    }),
  );
  const createTap = vi.fn(
    (
      _ctx: AudioContext,
      _source: AudioNode,
      _channels: number,
      cb: (channels: ReadonlyArray<Float32Array>) => void,
    ): CaptureTap => {
      onBlock = cb;
      return { close: tapClose };
    },
  );
  const deps: RecorderOptions = { getUserMedia, bindInput, createTap };
  const push = (channels: Float32Array[]): void => {
    onBlock?.(channels);
  };
  return { deps, push, stream, source, bindingClose, tapClose, getUserMedia, bindInput, createTap };
}

/** A block whose frame values continue a global ramp (frame index = value). */
function rampBlock(channels: number, frames: number, startValue: number): Float32Array[] {
  const block: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const channel = new Float32Array(frames);
    for (let i = 0; i < frames; i++) channel[i] = (startValue + i) * (c + 1);
    block.push(channel);
  }
  return block;
}

describe('createRecorder microphone acquisition', () => {
  it('requests tracking-quality constraints, binds the stream and installs the tap', async () => {
    const { handle, node } = makeHandle();
    const { deps, getUserMedia, bindInput, createTap, stream, source } = makeDeps(2);
    const recorder = createRecorder(handle, deps);
    expect(recorder.hasMicrophone()).toBe(false);

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
    expect(createTap).toHaveBeenCalledWith(handle.ctx, source, 2, expect.any(Function));

    // Idempotent: a second request does not reacquire the device.
    await recorder.requestMicrophone();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('falls back to 2 tap channels when the track exposes no settings', async () => {
    const { handle } = makeHandle();
    const { deps, createTap } = makeDeps(2);
    const stream = {
      getAudioTracks: () => [{ stop: vi.fn() }],
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    deps.getUserMedia = vi.fn(async () => stream);
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    expect(createTap.mock.calls[0][2]).toBe(2);
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

  it('closes the binding when the tap cannot be created', async () => {
    const { handle } = makeHandle();
    const { deps, bindingClose } = makeDeps();
    deps.createTap = vi.fn(() => {
      throw new NotSupportedError('no tap');
    });
    const recorder = createRecorder(handle, deps);
    await expect(recorder.requestMicrophone()).rejects.toBeInstanceOf(NotSupportedError);
    expect(bindingClose).toHaveBeenCalledTimes(1);
    expect(recorder.hasMicrophone()).toBe(false);
  });
});

describe('createRecorder state machine', () => {
  it('rejects start without a microphone, without an armed track, and double start', async () => {
    const { handle } = makeHandle();
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    const startOptions = { startPpq: 0, tempoBpm: 120 };

    expect(() => recorder.start(startOptions)).toThrow(RecorderStateError);
    await recorder.requestMicrophone();
    expect(() => recorder.start(startOptions)).toThrow(RecorderStateError);
    recorder.arm(3);
    expect(recorder.armedTrackId()).toBe(3);
    recorder.start(startOptions);
    expect(recorder.isRecording()).toBe(true);
    expect(() => recorder.start(startOptions)).toThrow(RecorderStateError);
    recorder.stop();
    expect(recorder.isRecording()).toBe(false);
  });

  it('rejects stop and re-arm in the wrong state', async () => {
    const { handle } = makeHandle();
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    expect(() => recorder.stop()).toThrow(RecorderStateError);
    await recorder.requestMicrophone();
    recorder.arm(1);
    recorder.start({ startPpq: 0, tempoBpm: 120 });
    expect(() => recorder.arm(2)).toThrow(RecorderStateError);
    expect(() => recorder.disarm()).toThrow(RecorderStateError);
    recorder.stop();
    recorder.disarm();
    expect(recorder.armedTrackId()).toBe(null);
  });

  it('validates start options', async () => {
    const { handle } = makeHandle();
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);
    expect(() => recorder.start({ startPpq: -1, tempoBpm: 120 })).toThrow(RangeError);
    expect(() => recorder.start({ startPpq: 0, tempoBpm: 0 })).toThrow(RangeError);
    expect(() => recorder.start({ startPpq: 0, tempoBpm: 120, countInPpq: -1 })).toThrow(
      RangeError,
    );
    expect(() => recorder.start({ startPpq: 0, tempoBpm: 120, recordOffsetSamples: -5 })).toThrow(
      RangeError,
    );
    expect(() => recorder.start({ startPpq: 0, tempoBpm: 120, maxDurationSeconds: 0 })).toThrow(
      RangeError,
    );
    expect(recorder.isRecording()).toBe(false);
  });
});

describe('createRecorder capture', () => {
  it('arms the engine record path and sets the punch window on start', async () => {
    const { handle, armRecord, punch } = makeHandle(100);
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(7);
    recorder.start({ startPpq: 8, tempoBpm: 120, maxDurationSeconds: 30 });

    expect(armRecord).toHaveBeenCalledWith('track-7', true);
    // Punch-out = startPpq + maxDuration in PPQ (30 s at 120 BPM = 60 PPQ).
    expect(punch).toHaveBeenCalledWith(8, 68);

    recorder.stop();
    expect(armRecord).toHaveBeenLastCalledWith('track-7', false);
  });

  it('skips the count-in span plus the latency offset and returns the rest', async () => {
    const { handle } = makeHandle(100);
    const { deps, push } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);
    // Count-in 2 PPQ at 120 BPM = 1 s = 100 frames; offset 10 -> skip 110.
    recorder.start({ startPpq: 8, tempoBpm: 120, countInPpq: 2, recordOffsetSamples: 10 });

    push(rampBlock(1, 60, 0));
    push(rampBlock(1, 60, 60));
    push(rampBlock(1, 60, 120));

    const result = recorder.stop();
    expect(result).not.toBeNull();
    expect(result?.startPpq).toBe(8);
    expect(result?.sampleRate).toBe(100);
    expect(result?.channels).toHaveLength(1);
    const channel = result?.channels[0] as Float32Array;
    expect(channel.length).toBe(70);
    expect(channel[0]).toBe(110);
    expect(channel[69]).toBe(179);
  });

  it('derives the default latency offset from the context latency', async () => {
    // baseLatency 0.1 s at 100 Hz = 10 frames skipped.
    const { handle } = makeHandle(100, 0.1);
    const { deps, push } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);
    recorder.start({ startPpq: 0, tempoBpm: 120 });
    push(rampBlock(1, 30, 0));
    const channel = recorder.stop()?.channels[0] as Float32Array;
    expect(channel.length).toBe(20);
    expect(channel[0]).toBe(10);
  });

  it('preserves stereo channels independently', async () => {
    const { handle } = makeHandle(100);
    const { deps, push } = makeDeps(2);
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);
    recorder.start({ startPpq: 0, tempoBpm: 120, recordOffsetSamples: 0 });
    push(rampBlock(2, 4, 1));
    const result = recorder.stop();
    expect(result?.channels).toHaveLength(2);
    expect(Array.from(result?.channels[0] ?? [])).toEqual([1, 2, 3, 4]);
    expect(Array.from(result?.channels[1] ?? [])).toEqual([2, 4, 6, 8]);
  });

  it('returns null when stopped before any post-skip frame arrived', async () => {
    const { handle, armRecord } = makeHandle(100);
    const { deps, push } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);
    recorder.start({ startPpq: 4, tempoBpm: 120, countInPpq: 2, recordOffsetSamples: 0 });
    push(rampBlock(1, 50, 0)); // still inside the 100-frame count-in
    expect(recorder.stop()).toBeNull();
    expect(armRecord).toHaveBeenLastCalledWith('track-1', false);
  });

  it('caps the take at maxDurationSeconds', async () => {
    const { handle } = makeHandle(100);
    const { deps, push } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);
    recorder.start({
      startPpq: 0,
      tempoBpm: 120,
      recordOffsetSamples: 0,
      maxDurationSeconds: 0.5,
    });
    push(rampBlock(1, 40, 0));
    push(rampBlock(1, 40, 40));
    push(rampBlock(1, 40, 80));
    const channel = recorder.stop()?.channels[0] as Float32Array;
    expect(channel.length).toBe(50);
    expect(channel[49]).toBe(49);
  });

  it('ignores blocks while not recording', async () => {
    const { handle } = makeHandle(100);
    const { deps, push } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(1);
    push(rampBlock(1, 64, 0)); // before start: dropped
    recorder.start({ startPpq: 0, tempoBpm: 120, recordOffsetSamples: 0 });
    push(rampBlock(1, 4, 7));
    expect(Array.from(recorder.stop()?.channels[0] ?? [])).toEqual([7, 8, 9, 10]);
  });
});

describe('createRecorder monitoring and levels', () => {
  it('connects the monitor gain only when enabled and remembers the pre-mic state', async () => {
    const { handle, gains, destination } = makeHandle();
    const { deps } = makeDeps();
    const recorder = createRecorder(handle, deps);
    recorder.setMonitor(true, 0.5); // before the mic exists: remembered
    expect(recorder.monitorEnabled()).toBe(true);

    await recorder.requestMicrophone();
    expect(gains).toHaveLength(1);
    const monitor = gains[0];
    expect(monitor.gain.value).toBe(0.5);
    expect(monitor.connect).toHaveBeenCalledWith(destination);

    recorder.setMonitor(false);
    expect(recorder.monitorEnabled()).toBe(false);
    expect(monitor.gain.value).toBe(0);
    expect(monitor.disconnect).toHaveBeenCalledTimes(1);

    recorder.setMonitor(true, 2);
    expect(monitor.gain.value).toBe(2);
    expect(monitor.connect).toHaveBeenCalledTimes(2);

    expect(() => recorder.setMonitor(true, -1)).toThrow(RangeError);
  });

  it('stays disconnected from the destination while monitoring is off', async () => {
    const { handle, gains } = makeHandle();
    const { deps, source } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    const monitor = gains[0];
    // The mic source feeds the gain stage, but the gain stage never reaches
    // the destination (and is held at zero) until monitoring is enabled.
    expect(source.connect).toHaveBeenCalledWith(monitor);
    expect(monitor.gain.value).toBe(0);
    expect(monitor.connect).not.toHaveBeenCalled();
  });

  it('publishes throttled input peaks to level listeners', async () => {
    const { handle } = makeHandle();
    const { deps, push } = makeDeps();
    const recorder = createRecorder(handle, { ...deps, levelIntervalMs: 0 });
    const levels: number[] = [];
    const unsubscribe = recorder.onLevel((peak) => levels.push(peak));

    await recorder.requestMicrophone();
    push([new Float32Array([0.125, -0.75, 0.5])]);
    expect(levels).toEqual([0.75]);

    unsubscribe();
    push([new Float32Array([0.875])]);
    expect(levels).toEqual([0.75]);
  });

  it('coalesces level callbacks within the throttle interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const { handle } = makeHandle();
      const { deps, push } = makeDeps();
      const recorder = createRecorder(handle, { ...deps, levelIntervalMs: 50 });
      const levels: number[] = [];
      recorder.onLevel((peak) => levels.push(peak));
      await recorder.requestMicrophone();

      push([new Float32Array([0.25])]); // first block always emits
      push([new Float32Array([0.75])]); // within the window: held back
      expect(levels).toEqual([0.25]);
      vi.setSystemTime(1_000_100);
      push([new Float32Array([0.125])]); // window elapsed: max since last emit
      expect(levels).toEqual([0.25, 0.75]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createRecorder teardown', () => {
  it('dispose closes the tap, the binding and the monitor path', async () => {
    const { handle, gains } = makeHandle();
    const { deps, push, bindingClose, tapClose } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.setMonitor(true);

    recorder.dispose();
    expect(tapClose).toHaveBeenCalledTimes(1);
    expect(bindingClose).toHaveBeenCalledTimes(1);
    expect(gains[0].disconnect).toHaveBeenCalled();
    expect(recorder.hasMicrophone()).toBe(false);
    push([new Float32Array([0.5])]); // late blocks are harmless

    // Idempotent and terminal.
    recorder.dispose();
    expect(tapClose).toHaveBeenCalledTimes(1);
    await expect(recorder.requestMicrophone()).rejects.toBeInstanceOf(RecorderStateError);
    expect(() => recorder.start({ startPpq: 0, tempoBpm: 120 })).toThrow(RecorderStateError);
  });

  it('dispose during a recording disarms the engine and discards the take', async () => {
    const { handle, armRecord } = makeHandle();
    const { deps, push } = makeDeps();
    const recorder = createRecorder(handle, deps);
    await recorder.requestMicrophone();
    recorder.arm(4);
    recorder.start({ startPpq: 0, tempoBpm: 120, recordOffsetSamples: 0 });
    push(rampBlock(1, 16, 0));

    recorder.dispose();
    expect(recorder.isRecording()).toBe(false);
    expect(armRecord).toHaveBeenLastCalledWith('track-4', false);
  });

  it('rejects a microphone that finishes binding after dispose', async () => {
    const { handle } = makeHandle();
    const { deps, bindingClose, tapClose } = makeDeps();
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
    expect(tapClose).not.toHaveBeenCalled();
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
