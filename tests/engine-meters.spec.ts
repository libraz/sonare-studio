import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import { createMeterBridge, METER_SILENCE_DB, type StereoMeterLevels } from '@/engine/meters';
import type { SonareWorkletMeterSnapshot } from '@/wasm/worklet.js';

/** Full engine meter record with overridable fields. */
function makeSnapshot(
  overrides: Partial<SonareWorkletMeterSnapshot> = {},
): SonareWorkletMeterSnapshot {
  return {
    type: 'meter',
    targetId: 0,
    frame: 128,
    peakDbL: -6,
    peakDbR: -7,
    rmsDbL: -12,
    rmsDbR: -13,
    correlation: 0.5,
    truePeakDbL: -5.5,
    truePeakDbR: -6.5,
    momentaryLufs: -14,
    shortTermLufs: -15,
    integratedLufs: -16,
    gainReductionDb: 0,
    ...overrides,
  };
}

/** EngineHandle stub capturing the onMeter callback and pollMeters calls. */
function makeHandle(mode: 'sab' | 'postMessage' = 'postMessage'): {
  handle: EngineHandle;
  emit: (snapshot: SonareWorkletMeterSnapshot) => void;
  pollMeters: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let captured: ((snapshot: SonareWorkletMeterSnapshot) => void) | null = null;
  const unsubscribe = vi.fn();
  const pollMeters = vi.fn(() => [] as SonareWorkletMeterSnapshot[]);
  const engine = {
    onMeter: vi.fn((cb: (snapshot: SonareWorkletMeterSnapshot) => void) => {
      captured = cb;
      return unsubscribe;
    }),
    pollMeters,
  };
  const handle = { engine, capabilities: { mode } } as unknown as EngineHandle;
  return {
    handle,
    emit: (snapshot) => captured?.(snapshot),
    pollMeters,
    unsubscribe,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createMeterBridge', () => {
  it('starts silent on the master source and every target source', () => {
    const { handle } = makeHandle();
    const bridge = createMeterBridge(handle);

    const silent: StereoMeterLevels = {
      frame: 0,
      peakDbL: METER_SILENCE_DB,
      peakDbR: METER_SILENCE_DB,
      rmsDbL: METER_SILENCE_DB,
      rmsDbR: METER_SILENCE_DB,
      correlation: 0,
    };
    expect(bridge.latest).toEqual(silent);
    expect(bridge.forTarget(3).latest).toEqual(silent);
    bridge.dispose();
  });

  it('updates the master latest and notifies master listeners on target 0', () => {
    const { handle, emit } = makeHandle();
    const bridge = createMeterBridge(handle);
    const listener = vi.fn();
    bridge.subscribe(listener);

    emit(makeSnapshot({ frame: 256, peakDbL: -3 }));
    expect(bridge.latest.frame).toBe(256);
    expect(bridge.latest.peakDbL).toBe(-3);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(bridge.latest);
    bridge.dispose();
  });

  it('does not touch the master state for non-master records', () => {
    const { handle, emit } = makeHandle();
    const bridge = createMeterBridge(handle);
    const listener = vi.fn();
    bridge.subscribe(listener);

    emit(makeSnapshot({ targetId: 3, frame: 512 }));
    expect(bridge.latest.frame).toBe(0);
    expect(bridge.latest.peakDbL).toBe(METER_SILENCE_DB);
    expect(listener).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it('routes lane records to forTarget sources only', () => {
    const { handle, emit } = makeHandle();
    const bridge = createMeterBridge(handle);
    const lane = bridge.forTarget(3);
    const laneListener = vi.fn();
    lane.subscribe(laneListener);

    emit(makeSnapshot({ targetId: 3, frame: 100, peakDbL: -9 }));
    expect(lane.latest.frame).toBe(100);
    expect(lane.latest.peakDbL).toBe(-9);
    expect(laneListener).toHaveBeenCalledTimes(1);

    // A master record does not reach the lane source.
    emit(makeSnapshot({ targetId: 0, frame: 200 }));
    expect(lane.latest.frame).toBe(100);
    expect(laneListener).toHaveBeenCalledTimes(1);
    bridge.dispose();
  });

  it('passes finite full-record fields through and omits non-finite ones', () => {
    const { handle, emit } = makeHandle();
    const bridge = createMeterBridge(handle);

    emit(makeSnapshot({ truePeakDbL: -4.2, momentaryLufs: -14.5 }));
    expect(bridge.latest.truePeakDbL).toBe(-4.2);
    expect(bridge.latest.truePeakDbR).toBe(-6.5);
    expect(bridge.latest.momentaryLufs).toBe(-14.5);
    expect(bridge.latest.shortTermLufs).toBe(-15);
    expect(bridge.latest.integratedLufs).toBe(-16);

    emit(
      makeSnapshot({
        truePeakDbL: Number.NEGATIVE_INFINITY,
        truePeakDbR: Number.NEGATIVE_INFINITY,
        momentaryLufs: Number.NEGATIVE_INFINITY,
        shortTermLufs: Number.NEGATIVE_INFINITY,
        integratedLufs: Number.NEGATIVE_INFINITY,
      }),
    );
    expect(bridge.latest).not.toHaveProperty('truePeakDbL');
    expect(bridge.latest).not.toHaveProperty('truePeakDbR');
    expect(bridge.latest).not.toHaveProperty('momentaryLufs');
    expect(bridge.latest).not.toHaveProperty('shortTermLufs');
    expect(bridge.latest).not.toHaveProperty('integratedLufs');
    bridge.dispose();
  });

  it('clamps non-finite peak/RMS values to the silence floor', () => {
    const { handle, emit } = makeHandle();
    const bridge = createMeterBridge(handle);

    emit(
      makeSnapshot({
        peakDbL: Number.NEGATIVE_INFINITY,
        rmsDbR: Number.NaN,
      }),
    );
    expect(bridge.latest.peakDbL).toBe(METER_SILENCE_DB);
    expect(bridge.latest.rmsDbR).toBe(METER_SILENCE_DB);
    bridge.dispose();
  });

  it('stops delivering to an unsubscribed listener', () => {
    const { handle, emit } = makeHandle();
    const bridge = createMeterBridge(handle);
    const listener = vi.fn();
    const unsubscribe = bridge.subscribe(listener);

    emit(makeSnapshot());
    unsubscribe();
    unsubscribe();
    emit(makeSnapshot({ frame: 999 }));
    expect(listener).toHaveBeenCalledTimes(1);
    bridge.dispose();
  });

  it('dispose stops delivery and releases the engine subscription', () => {
    const { handle, emit, unsubscribe } = makeHandle();
    const bridge = createMeterBridge(handle);
    const masterListener = vi.fn();
    const laneListener = vi.fn();
    bridge.subscribe(masterListener);
    bridge.forTarget(3).subscribe(laneListener);

    bridge.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    emit(makeSnapshot());
    emit(makeSnapshot({ targetId: 3 }));
    expect(masterListener).not.toHaveBeenCalled();
    expect(laneListener).not.toHaveBeenCalled();

    // Idempotent.
    bridge.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('drains pollMeters in SAB mode and publishes every record to its target', () => {
    // Drive the poll loop manually through a stubbed requestAnimationFrame.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const { handle, pollMeters } = makeHandle('sab');
    const bridge = createMeterBridge(handle);
    const lane = bridge.forTarget(3);
    const laneListener = vi.fn();
    lane.subscribe(laneListener);

    pollMeters.mockReturnValueOnce([
      makeSnapshot({ targetId: 0, frame: 100, peakDbL: -3 }),
      makeSnapshot({ targetId: 3, frame: 100, peakDbL: -20 }),
      makeSnapshot({ targetId: 3, frame: 228, peakDbL: -18 }),
    ]);
    expect(frames).toHaveLength(1);
    frames.at(-1)?.(performance.now());

    expect(pollMeters).toHaveBeenCalledTimes(1);
    expect(bridge.latest.frame).toBe(100);
    expect(bridge.latest.peakDbL).toBe(-3);
    // Both lane records are delivered; latest reflects the newest one.
    expect(laneListener).toHaveBeenCalledTimes(2);
    expect(lane.latest.frame).toBe(228);
    expect(lane.latest.peakDbL).toBe(-18);

    // The loop re-arms itself each frame.
    expect(frames).toHaveLength(2);
    frames.at(-1)?.(performance.now());
    expect(pollMeters).toHaveBeenCalledTimes(2);
    bridge.dispose();
  });

  it('does not start the poll loop in postMessage mode', () => {
    let scheduled = 0;
    vi.stubGlobal('requestAnimationFrame', (): number => {
      scheduled++;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const { handle, pollMeters } = makeHandle('postMessage');
    const bridge = createMeterBridge(handle);
    expect(scheduled).toBe(0);
    expect(pollMeters).not.toHaveBeenCalled();
    bridge.dispose();
  });
});
