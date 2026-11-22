import type { WorkletMeterSnapshot } from '@libraz/libsonare/worklet';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import {
  createMeterBridge,
  INSERT_GAIN_REDUCTION_POLL_MS,
  type StereoMeterLevels,
} from '@/engine/meters';
import { SILENCE_DB } from '@/lib/db';
import { fakeEngineHandle } from './fakes/engine';

/** Full engine meter record with overridable fields. */
function makeSnapshot(overrides: Partial<WorkletMeterSnapshot> = {}): WorkletMeterSnapshot {
  return {
    type: 'meter',
    targetId: 0,
    frame: 128,
    peakDbL: -6,
    peakDbR: -7,
    rmsDbL: -12,
    rmsDbR: -13,
    correlation: 0.5,
    truePeakDbtpL: -5.5,
    truePeakDbtpR: -6.5,
    momentaryLufs: -14,
    shortTermLufs: -15,
    integratedLufs: -16,
    gainReductionDb: 0,
    inputPeakDbL: -6,
    inputPeakDbR: -7,
    ...overrides,
  };
}

/** EngineHandle stub capturing the onMeter callback and pollMeters calls. */
function makeHandle(mode: 'sab' | 'postMessage' = 'postMessage'): {
  handle: EngineHandle;
  emit: (snapshot: WorkletMeterSnapshot) => void;
  pollMeters: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let captured: ((snapshot: WorkletMeterSnapshot) => void) | null = null;
  const unsubscribe = vi.fn();
  const pollMeters = vi.fn(() => [] as WorkletMeterSnapshot[]);
  const engine = {
    onMeter: vi.fn((cb: (snapshot: WorkletMeterSnapshot) => void) => {
      captured = cb;
      return unsubscribe;
    }),
    pollMeters,
  };
  const handle = fakeEngineHandle({ engine, capabilities: { mode } });
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
      peakDbL: SILENCE_DB,
      peakDbR: SILENCE_DB,
      rmsDbL: SILENCE_DB,
      rmsDbR: SILENCE_DB,
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
    expect(bridge.latest.peakDbL).toBe(SILENCE_DB);
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

    emit(makeSnapshot({ truePeakDbtpL: -4.2, momentaryLufs: -14.5, gainReductionDb: -3.5 }));
    expect(bridge.latest.truePeakDbtpL).toBe(-4.2);
    expect(bridge.latest.truePeakDbtpR).toBe(-6.5);
    expect(bridge.latest.momentaryLufs).toBe(-14.5);
    expect(bridge.latest.shortTermLufs).toBe(-15);
    expect(bridge.latest.integratedLufs).toBe(-16);
    expect(bridge.latest.gainReductionDb).toBe(-3.5);

    emit(
      makeSnapshot({
        truePeakDbtpL: Number.NEGATIVE_INFINITY,
        truePeakDbtpR: Number.NEGATIVE_INFINITY,
        momentaryLufs: Number.NEGATIVE_INFINITY,
        shortTermLufs: Number.NEGATIVE_INFINITY,
        integratedLufs: Number.NEGATIVE_INFINITY,
        gainReductionDb: Number.NaN,
      }),
    );
    expect(bridge.latest).not.toHaveProperty('truePeakDbtpL');
    expect(bridge.latest).not.toHaveProperty('truePeakDbtpR');
    expect(bridge.latest).not.toHaveProperty('momentaryLufs');
    expect(bridge.latest).not.toHaveProperty('shortTermLufs');
    expect(bridge.latest).not.toHaveProperty('integratedLufs');
    expect(bridge.latest).not.toHaveProperty('gainReductionDb');
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
    expect(bridge.latest.peakDbL).toBe(SILENCE_DB);
    expect(bridge.latest.rmsDbR).toBe(SILENCE_DB);
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

  it('delivers every record exactly once from onMeter in SAB mode', () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const { handle, emit, pollMeters } = makeHandle('sab');
    const bridge = createMeterBridge(handle);
    const lane = bridge.forTarget(3);
    const masterListener = vi.fn();
    const laneListener = vi.fn();
    bridge.subscribe(masterListener);
    lane.subscribe(laneListener);

    emit(makeSnapshot({ targetId: 0, frame: 100, peakDbL: -3 }));
    emit(makeSnapshot({ targetId: 3, frame: 100, peakDbL: -20 }));
    emit(makeSnapshot({ targetId: 3, frame: 228, peakDbL: -18 }));

    expect(masterListener).toHaveBeenCalledTimes(1);
    expect(bridge.latest.frame).toBe(100);
    expect(laneListener).toHaveBeenCalledTimes(2);
    expect(lane.latest.frame).toBe(228);
    // The facade's own ring poller owns the read index, so the bridge never drains it.
    expect(pollMeters).not.toHaveBeenCalled();
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

  it('runs the SAB poll loop only while an insert gain-reduction listener exists', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { handle } = makeHandle('sab');
    (handle.engine as unknown as Record<string, unknown>).pollInsertGainReduction = vi.fn(
      async () => [0],
    );
    const bridge = createMeterBridge(handle);
    bridge.subscribe(vi.fn());
    expect(frames).toHaveLength(0);

    const unsubscribe = bridge.forTarget(2).subscribeInsertGainReduction(vi.fn());
    const second = bridge.forTarget(2).subscribeInsertGainReduction(vi.fn());
    expect(frames).toHaveLength(1);

    unsubscribe();
    frames.at(-1)?.(0);
    expect(frames).toHaveLength(2);
    second();
    frames.at(-1)?.(100);
    expect(frames).toHaveLength(2);

    bridge.forTarget(2).subscribeInsertGainReduction(vi.fn());
    expect(frames).toHaveLength(3);
    bridge.dispose();
  });

  it('fans postMessage per-insert gain reduction out to that target only', () => {
    const { handle, emit } = makeHandle();
    const bridge = createMeterBridge(handle);
    const lane = vi.fn();
    const master = vi.fn();
    const unsubscribe = bridge.forTarget(3).subscribeInsertGainReduction(lane);
    bridge.subscribeInsertGainReduction(master);

    emit(makeSnapshot({ targetId: 3, insertGainReductionDb: [0, -4.5] }));
    // Backlogged records omit the array and publish nothing.
    emit(makeSnapshot({ targetId: 3 }));
    expect(lane).toHaveBeenCalledTimes(1);
    expect(lane).toHaveBeenCalledWith([0, -4.5]);
    expect(master).not.toHaveBeenCalled();

    unsubscribe();
    emit(makeSnapshot({ targetId: 3, insertGainReductionDb: [-1] }));
    expect(lane).toHaveBeenCalledTimes(1);
    bridge.dispose();
  });

  it('polls per-insert gain reduction in SAB mode only for watched targets, throttled', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { handle } = makeHandle('sab');
    const pollInsertGainReduction = vi.fn(async (_targetId: number) => [-2, 0]);
    (handle.engine as unknown as Record<string, unknown>).pollInsertGainReduction =
      pollInsertGainReduction;
    const bridge = createMeterBridge(handle);
    expect(frames).toHaveLength(0);

    const listener = vi.fn();
    bridge.forTarget(4).subscribeInsertGainReduction(listener);
    expect(frames).toHaveLength(1);
    frames.at(-1)?.(100);
    // A second frame while the request is in flight does not stack requests.
    frames.at(-1)?.(200);
    expect(pollInsertGainReduction).toHaveBeenCalledTimes(1);
    expect(pollInsertGainReduction).toHaveBeenCalledWith(4);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith([-2, 0]);

    frames.at(-1)?.(100 + INSERT_GAIN_REDUCTION_POLL_MS - 1);
    expect(pollInsertGainReduction).toHaveBeenCalledTimes(1);
    frames.at(-1)?.(100 + INSERT_GAIN_REDUCTION_POLL_MS);
    expect(pollInsertGainReduction).toHaveBeenCalledTimes(2);
    bridge.dispose();
  });
});
