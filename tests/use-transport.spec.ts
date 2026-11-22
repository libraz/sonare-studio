import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { shallowRef } from 'vue';
import { useTransport } from '@/composables/useTransport';
import type { EngineHandle } from '@/engine/engine';
import * as core from '@/wasm/index.js';
import { type EngineTelemetry, ErrorCode, SonareError } from '@/wasm/index.js';
import { fakeEngineHandle } from './fakes/engine';

/** The refusal a full engine command ring raises. */
const ringFull = (): SonareError => new SonareError(ErrorCode.OutOfMemory, 'command ring full');

interface MockHandle {
  handle: EngineHandle;
  transport: {
    play: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    seekPpq: ReturnType<typeof vi.fn>;
    seekSec: ReturnType<typeof vi.fn>;
    setTempo: ReturnType<typeof vi.fn>;
    setLoop: ReturnType<typeof vi.fn>;
  };
  setMetronome: ReturnType<typeof vi.fn>;
  pushMidiPanic: ReturnType<typeof vi.fn>;
  pollTelemetry: ReturnType<typeof vi.fn>;
  emitTelemetry: (record: Partial<EngineTelemetry>) => void;
}

/** Builds a plain-object EngineHandle mock (no real AudioContext / AudioWorklet). */
function createMockHandle(sampleRate = 48000): MockHandle {
  const transport = {
    play: vi.fn(),
    stop: vi.fn(),
    seekPpq: vi.fn(),
    seekSec: vi.fn(),
    setTempo: vi.fn(),
    setLoop: vi.fn(),
  };
  const setMetronome = vi.fn();
  const pushMidiPanic = vi.fn();
  const pollTelemetry = vi.fn(() => []);
  let telemetryListener: ((record: EngineTelemetry) => void) | null = null;
  const engine = {
    transport,
    setMetronome,
    pushMidiPanic,
    pollTelemetry,
    onTelemetry: vi.fn((cb: (record: EngineTelemetry) => void) => {
      telemetryListener = cb;
      return () => {
        telemetryListener = null;
      };
    }),
  };
  const handle = fakeEngineHandle({
    engine,
    ctx: { sampleRate, baseLatency: 0.01, outputLatency: 0.02 },
    capabilities: { mode: 'postMessage' },
    dispose: vi.fn(),
  });
  const emitTelemetry = (record: Partial<EngineTelemetry>): void => {
    telemetryListener?.({
      type: 'processBlock',
      error: 'none',
      renderFrame: 0,
      timelineSample: 0,
      audibleTimelineSample: 0,
      graphLatencySamples: 0,
      value: 0,
      ...record,
    });
  };
  return { handle, transport, setMetronome, pushMidiPanic, pollTelemetry, emitTelemetry };
}

describe('useTransport', () => {
  const disposers: Array<() => void> = [];

  const setup = (handle: EngineHandle | null) => {
    const handleRef = shallowRef<EngineHandle | null>(handle);
    const transport = useTransport(() => handleRef.value);
    disposers.push(transport.dispose);
    return { transport, handleRef };
  };

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    vi.unstubAllGlobals();
  });

  it('play() delegates to engine.transport.play and sets isPlaying', () => {
    const mock = createMockHandle();
    const { transport } = setup(mock.handle);
    expect(transport.isPlaying.value).toBe(false);
    expect(transport.play()).toBe(true);
    expect(mock.transport.play).toHaveBeenCalledTimes(1);
    expect(mock.transport.play).toHaveBeenCalledWith(undefined);
    expect(transport.isPlaying.value).toBe(true);
    expect(transport.playbackLatencySeconds.value).toBeCloseTo(0.03);
  });

  it('tracks the audible telemetry position separately from the render timeline', () => {
    const mock = createMockHandle(48000);
    const { transport } = setup(mock.handle);
    transport.play();
    mock.emitTelemetry({ timelineSample: 96000, audibleTimelineSample: 93000 });

    expect(transport.positionPpq.value).toBe(4);
    expect(transport.audiblePositionPpq.value).toBeCloseTo(3.875);
  });

  it('play(renderFrame) commits only when process telemetry reaches the future frame', () => {
    const mock = createMockHandle();
    const { transport } = setup(mock.handle);
    transport.play(96000);
    expect(mock.transport.play).toHaveBeenCalledWith(96000);
    expect(transport.isPlaying.value).toBe(false);
    mock.emitTelemetry({ renderFrame: 95999 });
    expect(transport.isPlaying.value).toBe(false);
    mock.emitTelemetry({ renderFrame: 96000 });
    expect(transport.isPlaying.value).toBe(true);
  });

  it('stop() delegates to engine.transport.stop and clears isPlaying', () => {
    const mock = createMockHandle();
    const { transport } = setup(mock.handle);
    transport.play();
    expect(transport.stop()).toBe(true);
    expect(mock.transport.stop).toHaveBeenCalledWith(undefined);
    expect(mock.pushMidiPanic).toHaveBeenCalledTimes(1);
    expect(mock.pushMidiPanic).toHaveBeenCalledWith();
    expect(transport.isPlaying.value).toBe(false);
  });

  it('schedules future stop panic and UI state at the same render frame', () => {
    const mock = createMockHandle();
    const { transport } = setup(mock.handle);
    transport.play();
    expect(transport.stop(12345)).toBe(true);
    expect(mock.transport.stop).toHaveBeenCalledWith(12345);
    expect(mock.pushMidiPanic).toHaveBeenCalledWith(12345);
    expect(transport.isPlaying.value).toBe(true);
    mock.emitTelemetry({ renderFrame: 12344 });
    expect(transport.isPlaying.value).toBe(true);
    mock.emitTelemetry({ renderFrame: 12345 });
    expect(transport.isPlaying.value).toBe(false);
  });

  it('does not flip isPlaying when the engine rejects the command', () => {
    const mock = createMockHandle();
    mock.transport.play.mockImplementation(() => {
      throw ringFull();
    });
    const { transport } = setup(mock.handle);
    expect(transport.play()).toBe(false);
    expect(transport.isPlaying.value).toBe(false);
  });

  it('play and stop are no-ops returning false while the engine is not yet created', () => {
    const { transport, handleRef } = setup(null);
    expect(transport.play()).toBe(false);
    expect(transport.stop()).toBe(false);
    expect(transport.isPlaying.value).toBe(false);

    const mock = createMockHandle();
    handleRef.value = mock.handle;
    expect(transport.play()).toBe(true);
    expect(mock.transport.play).toHaveBeenCalledTimes(1);
  });

  it('seek() delegates to seekSec and updates an immediate position optimistically', () => {
    const mock = createMockHandle();
    const { transport } = setup(mock.handle);
    expect(transport.seek(2.5)).toBe(true);
    expect(mock.transport.seekSec).toHaveBeenCalledWith(2.5, undefined);
    expect(mock.pushMidiPanic).toHaveBeenCalledWith();
    expect(transport.positionSeconds.value).toBe(2.5);
  });

  it('commits a future seek only after its render frame is acknowledged', () => {
    const mock = createMockHandle();
    const { transport } = setup(mock.handle);
    expect(transport.seek(2.5, 1000)).toBe(true);
    expect(mock.transport.seekSec).toHaveBeenCalledWith(2.5, 1000);
    expect(mock.pushMidiPanic).toHaveBeenCalledWith(1000);
    expect(transport.positionSeconds.value).toBe(0);
    mock.emitTelemetry({ renderFrame: 999, timelineSample: 0 });
    expect(transport.positionSeconds.value).toBe(0);
    mock.emitTelemetry({ renderFrame: 1000, timelineSample: 0 });
    expect(transport.positionSeconds.value).toBe(2.5);
  });

  it('seekPpq() delegates and converts PPQ to seconds through the tempo map', () => {
    const mock = createMockHandle();
    const { transport } = setup(mock.handle);
    // Default map is a single constant 120 BPM segment: 2 ppq = 1 second.
    expect(transport.seekPpq(2)).toBe(true);
    expect(mock.transport.seekPpq).toHaveBeenCalledWith(2, undefined);
    expect(mock.pushMidiPanic).toHaveBeenCalledWith();
    expect(transport.positionPpq.value).toBe(2);
    expect(transport.positionSeconds.value).toBe(1);
  });

  it('setTempo() updates the local tempo ref without calling the engine', () => {
    const mock = createMockHandle();
    const { transport } = setup(mock.handle);
    transport.setTempo(90);
    expect(mock.transport.setTempo).not.toHaveBeenCalled();
    expect(transport.tempo.value).toBe(90);
    // Conversions still use the tempo map (default 120 BPM), not the tempo ref.
    transport.seek(2);
    expect(transport.positionPpq.value).toBe(4);
  });

  it('converts telemetry and seekPpq positions through a multi-segment tempo map', () => {
    const mock = createMockHandle(48000);
    const { transport } = setup(mock.handle);
    transport.setTempoMap([
      { startPpq: 0, bpm: 120 },
      { startPpq: 4, bpm: 60 },
    ]);
    transport.play();
    // 3 s of audio: 2 s cover ppq 0..4 at 120 BPM, then 1 s = 1 ppq at 60 BPM.
    mock.emitTelemetry({ type: 'processBlock', timelineSample: 3 * 48000 });
    expect(transport.positionPpq.value).toBeCloseTo(5, 9);
    // ppq 6 = 2 s (ppq 0..4 at 120) + 2 s (ppq 4..6 at 60).
    expect(transport.seekPpq(6)).toBe(true);
    expect(transport.positionSeconds.value).toBeCloseTo(4, 9);
  });

  it('setTempoMap() keeps positionPpq and re-derives positionSeconds', () => {
    const mock = createMockHandle();
    const { transport } = setup(mock.handle);
    transport.seekPpq(4);
    expect(transport.positionSeconds.value).toBe(2);
    transport.setTempoMap([{ startPpq: 0, bpm: 60 }]);
    expect(transport.positionPpq.value).toBe(4);
    expect(transport.positionSeconds.value).toBe(4);
  });

  it('exposes a copied tempo map for downstream timing consumers', () => {
    const mock = createMockHandle();
    const { transport } = setup(mock.handle);
    const segments = [
      { startPpq: 0, bpm: 120 },
      { startPpq: 4, bpm: 90, endBpm: 60 },
    ];

    transport.setTempoMap(segments);
    segments[1].bpm = 1;

    expect(transport.tempoSegments.value).toEqual([
      { startPpq: 0, bpm: 120 },
      { startPpq: 4, bpm: 90, endBpm: 60 },
    ]);
  });

  it('setLoop() delegates and mirrors the loop range', () => {
    const mock = createMockHandle();
    const { transport } = setup(mock.handle);
    expect(transport.setLoop(4, 8)).toBe(true);
    expect(mock.transport.setLoop).toHaveBeenCalledWith({ startPpq: 4, endPpq: 8, enabled: true });
    expect(transport.loopStartPpq.value).toBe(4);
    expect(transport.loopEndPpq.value).toBe(8);
    expect(transport.loopEnabled.value).toBe(true);

    transport.setLoop(0, 16, false);
    expect(mock.transport.setLoop).toHaveBeenCalledWith({
      startPpq: 0,
      endPpq: 16,
      enabled: false,
    });
    expect(transport.loopEnabled.value).toBe(false);
  });

  it('does not mirror the loop range when the engine rejects setLoop', () => {
    const mock = createMockHandle();
    mock.transport.setLoop.mockImplementation(() => {
      throw ringFull();
    });
    const { transport } = setup(mock.handle);
    expect(transport.setLoop(4, 8)).toBe(false);
    expect(transport.loopEnabled.value).toBe(false);
    expect(transport.loopStartPpq.value).toBe(0);
    expect(transport.loopEndPpq.value).toBe(0);
  });

  it('toggleMetronome() delegates to engine.setMetronome and flips state', () => {
    const mock = createMockHandle();
    const { transport } = setup(mock.handle);
    expect(transport.toggleMetronome()).toBe(true);
    expect(mock.setMetronome).toHaveBeenCalledWith({ enabled: true });
    expect(transport.metronomeEnabled.value).toBe(true);
    expect(transport.toggleMetronome()).toBe(false);
    expect(mock.setMetronome).toHaveBeenLastCalledWith({ enabled: false });
    expect(transport.toggleMetronome(false)).toBe(false);
    expect(mock.setMetronome).toHaveBeenLastCalledWith({ enabled: false });
  });

  it('keeps the metronome state when the engine cannot queue the change', () => {
    const mock = createMockHandle();
    const { transport } = setup(mock.handle);
    mock.setMetronome.mockImplementationOnce(() => {
      throw ringFull();
    });
    expect(transport.toggleMetronome()).toBe(false);
    expect(transport.metronomeEnabled.value).toBe(false);
  });

  it('updates the metronome beat and accent gains without changing its state', () => {
    const mock = createMockHandle();
    const { transport } = setup(mock.handle);

    expect(transport.toggleMetronome(false, 0.4)).toBe(false);
    expect(mock.setMetronome).toHaveBeenCalledWith({
      enabled: false,
      beatGain: 0.4,
      accentGain: 0.8,
    });
  });

  it('updates positionSeconds from the non-latency-compensated timeline telemetry', () => {
    const mock = createMockHandle(48000);
    const { transport } = setup(mock.handle);
    transport.play();
    mock.emitTelemetry({
      type: 'processBlock',
      timelineSample: 96000,
      audibleTimelineSample: 72000,
    });
    expect(transport.positionSeconds.value).toBe(2);
    // Non-ProcessBlock records (e.g. errors) must not move the playhead.
    mock.emitTelemetry({ type: 'error', timelineSample: 480000 });
    expect(transport.positionSeconds.value).toBe(2);
  });

  it('falls back to audibleTimelineSample when timelineSample is unavailable', () => {
    const mock = createMockHandle(48000);
    const { transport } = setup(mock.handle);
    transport.play();
    mock.emitTelemetry({
      type: 'processBlock',
      timelineSample: Number.NaN,
      audibleTimelineSample: 48000,
    });
    expect(transport.positionSeconds.value).toBe(1);
  });

  it('stops reacting to telemetry after dispose()', () => {
    const mock = createMockHandle(48000);
    const { transport } = setup(mock.handle);
    transport.play();
    transport.dispose();
    mock.emitTelemetry({ type: 'processBlock', timelineSample: 48000 });
    expect(transport.positionSeconds.value).toBe(0);
  });

  it('cancels the telemetry polling frame on dispose()', () => {
    const requestAnimationFrame = vi.fn(() => 51);
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);
    const mock = createMockHandle();
    const { transport } = setup(mock.handle);

    expect(transport.play()).toBe(true);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    transport.dispose();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(51);
  });
});

describe('useTransport against the real engine telemetry', () => {
  beforeAll(async () => {
    await core.init({ wasmBinary: readFileSync(`${process.cwd()}/src/wasm/sonare.wasm`) });
  });

  it('follows the timeline position the engine reports per block', () => {
    const real = new core.RealtimeEngine({
      sampleRate: 48000,
      maxBlockSize: 128,
      commandCapacity: 64,
    });
    let listener: ((record: EngineTelemetry) => void) | null = null;
    const handle = fakeEngineHandle({
      engine: {
        transport: {
          play: () => real.play(),
          stop: () => real.stop(),
          seekPpq: vi.fn(),
          seekSec: vi.fn(),
          setTempo: vi.fn(),
          setLoop: vi.fn(),
        },
        setMetronome: vi.fn(),
        pushMidiPanic: vi.fn(),
        onTelemetry: (cb: (record: EngineTelemetry) => void) => {
          listener = cb;
          return () => {
            listener = null;
          };
        },
        pollTelemetry: () => {
          for (const record of real.drainTelemetry()) listener?.(record);
        },
      },
      ctx: { sampleRate: 48000, baseLatency: 0, outputLatency: 0 },
    });
    const handleRef = shallowRef<EngineHandle | null>(handle);
    const transport = useTransport(() => handleRef.value);
    try {
      expect(transport.play()).toBe(true);
      for (let block = 0; block < 4; block++) {
        real.process([new Float32Array(128), new Float32Array(128)]);
      }
      handle.engine.pollTelemetry();

      expect(transport.positionSeconds.value).toBeCloseTo(512 / 48000, 9);
    } finally {
      transport.dispose();
      real.destroy();
    }
  });
});
